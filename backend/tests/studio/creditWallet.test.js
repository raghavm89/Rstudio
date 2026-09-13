'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool         = require('../../src/config/db');
const StudioUsage  = require('../../src/models/studioUsage');
const CreditLedger = require('../../src/services/studio/creditLedger');
const Orchestrator = require('../../src/services/studio/orchestrator');
const { creditCostFor } = require('../../src/services/studio/creditCost');

/**
 * The per-piece credit wallet (settled 13 Sep 2026).
 *
 * One wallet, one currency, spent per rendered PIECE at the rate card — a still
 * is 1, a generative reel is its seconds at the resolution's rate, a lipsync is
 * flat by tier. The wallet rides the same metric-agnostic reserve/settle path as
 * every other quota; these tests hold the two ends of that: the rate card is
 * what a piece costs, and the machinery charges, releases and refunds it without
 * ever letting the counter and the purchased balance disagree.
 */

let TENANT, AVATAR;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('credit-wallet-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, lora_trigger)
     VALUES ($1,'cw-av','CW Av','synthetic','active','x','cw') RETURNING id`, [TENANT]
  );
  AVATAR = a.rows[0].id;
  await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'cw.safetensors','cw','flux1-dev.safetensors',TRUE)`, [AVATAR]
  );
  await pool.query(`INSERT INTO look_profiles (avatar_id) VALUES ($1)`, [AVATAR]);
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  // Leave the free wallet at its migration default, in case anything read it.
  await pool.query(
    `UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`
  );
  await pool.end();
});

const setWallet = (n) => pool.query(
  `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
   VALUES (NULL,'credits',$1,'month')
   ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`,
  [n]
);
const usedCredits = async () => {
  const { rows } = await pool.query(
    `SELECT used FROM studio_usage_counters WHERE tenant_id = $1 AND metric = 'credits'`, [TENANT]
  );
  return rows[0] ? Number(rows[0].used) : 0;
};
const reset = async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
};

// ── The rate card ─────────────────────────────────────────────────────────────

test('the rate card prices a piece, not a unit of time', () => {
  assert.strictEqual(creditCostFor({ stage: 'still' }), 1, 'a still is the anchor: 1 credit');
  assert.strictEqual(creditCostFor({ stage: 'motion', seconds: 30, resolution: '480p' }), 50, '30s 480p reel = 50');
  assert.strictEqual(creditCostFor({ stage: 'motion', seconds: 30, resolution: '720p' }), 100, '30s 720p reel = 100');
  assert.strictEqual(creditCostFor({ stage: 'lipsync', lipsyncTier: 'budget'  }), 6);
  assert.strictEqual(creditCostFor({ stage: 'lipsync', lipsyncTier: 'premium' }), 35);
  assert.strictEqual(creditCostFor({ stage: 'lipsync', lipsyncTier: 'max'     }), 48);
  // A lipsync is flat whatever its length; a generative reel scales with seconds.
  assert.strictEqual(creditCostFor({ stage: 'lipsync', lipsyncTier: 'budget', seconds: 12 }), 6);
  assert.strictEqual(creditCostFor({ stage: 'motion', seconds: 15, resolution: '720p' }), 50, 'half a 720p reel is half the credits');
  // A stage with no rate is free, deliberately — not a gap.
  assert.strictEqual(creditCostFor({ stage: 'copy' }), 0);
});

// ── The wallet, enforced ────────────────────────────────────────────────────

test('the wallet refuses an over-spend without consuming the allowance', async () => {
  await reset(); await setWallet(40);
  const c = await pool.connect();
  try {
    const r = await StudioUsage.reserve(c, TENANT, 'credits', 30);
    assert.strictEqual(Number(r.remaining), 10, '30 of 40 spent leaves 10');
    await assert.rejects(
      () => StudioUsage.reserve(c, TENANT, 'credits', 20),
      (err) => err.code === 'QUOTA_EXCEEDED'
    );
  } finally { c.release(); }
  assert.strictEqual(await usedCredits(), 30, 'a refused reservation rolls itself back');
});

test('a fixed piece charges exactly what it reserved, and a failure returns all of it', async () => {
  await reset(); await setWallet(40);
  const c = await pool.connect();
  try {
    // 8.33 = one 5s 480p clip. Fixed pieces do not reconcile against seconds.
    await StudioUsage.reserve(c, TENANT, 'credits', 8.33);
    await StudioUsage.settle(c, TENANT, 'credits', 8.33, 8.33, 'month');
    assert.ok(Math.abs(await usedCredits() - 8.33) < 0.01, 'the piece is charged');
    await StudioUsage.settle(c, TENANT, 'credits', 8.33, 0, 'month');
    assert.ok(Math.abs(await usedCredits()) < 0.01, 'a failed piece is released whole');
  } finally { c.release(); }
});

test('past the wallet, purchased credits pay — and a failure gives them back', async () => {
  await reset(); await setWallet(40);
  const c = await pool.connect();
  try {
    await CreditLedger.purchase(c, TENANT, 77, 'pay_cw_1', 'topup');
    // Reserve 50 against a 40 wallet: 40 from plan, 10 from the purchase.
    const r = await StudioUsage.reserve(c, TENANT, 'credits', 50, 'month', 'job:cw');
    assert.strictEqual(Number(r.from_credits), 10, 'only the part over the wallet touches the purchase');
    assert.strictEqual(await CreditLedger.balance(c, TENANT), 67);
    // The job fails: the counter releases and the 10 purchased credits come back.
    await StudioUsage.settle(c, TENANT, 'credits', 50, 0, 'month', { fromCredits: 10, reference: 'job:cw' });
    assert.strictEqual(await CreditLedger.balance(c, TENANT), 77, 'a failure must not keep purchased credits');
    assert.ok(Math.abs(await usedCredits()) < 0.01);
  } finally { c.release(); }
});

// ── The orchestrator reserves the whole shoot at the rate card ──────────────

test('a shoot reserves its rate-card total up front, split across its jobs', async () => {
  await reset(); await setWallet(100000);
  const out = await Orchestrator.createShoot({
    tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 3, tier: 'paid',
    clipSeconds: 5, resolution: '480p',
  });
  const expected = 3 * 1 + 3 * creditCostFor({ stage: 'motion', seconds: 5, resolution: '480p' });
  assert.ok(Math.abs(Number(out.reserved.credits) - expected) < 0.02, `reel reserves ${expected} credits`);
  assert.ok(Math.abs(await usedCredits() - expected) < 0.02, 'the counter reflects the whole shoot');

  const { rows } = await pool.query(
    `SELECT stage, payload FROM render_jobs WHERE project_id = $1`, [out.project.id]
  );
  const sum = rows.reduce((n, r) => n + Number(r.payload._reserved || 0), 0);
  assert.ok(Math.abs(sum - expected) < 0.02, 'per-job reservations sum to the shoot total, no leak');
  assert.ok(rows.filter((r) => r.stage === 'still').every((r) => Number(r.payload._reserved) === 1),
    'each delivered photo is one credit — candidates do not multiply it');
});

test('a 720p reel costs double the motion of a 480p one', async () => {
  await reset(); await setWallet(100000);
  const at = async (resolution) => {
    await reset(); await setWallet(100000);
    const out = await Orchestrator.createShoot({
      tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 3, tier: 'paid',
      clipSeconds: 5, resolution,
    });
    return Number(out.reserved.credits);
  };
  const lo = await at('480p');
  const hi = await at('720p');
  const stills = 3; // both have 3 one-credit stills
  assert.ok(Math.abs((hi - stills) - 2 * (lo - stills)) < 0.05, 'the video half doubles at 720p');
});

test('a shoot that will not fit the wallet is refused whole — no half-created project', async () => {
  await reset(); await setWallet(3);   // a 4-frame post is 4 credits
  await assert.rejects(
    () => Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 4, tier: 'paid' }),
    (err) => err.code === 'QUOTA_EXCEEDED'
  );
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  assert.strictEqual(rows[0].n, 0, 'a refused shoot leaves nothing behind');
});
