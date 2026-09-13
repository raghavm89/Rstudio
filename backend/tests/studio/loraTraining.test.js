'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pool          = require('../../src/config/db');
const LoraTraining  = require('../../src/services/studio/loraTraining');
const RenderJob     = require('../../src/models/renderJob');
const CreditLedger  = require('../../src/services/studio/creditLedger');

let TENANT, AVATAR;

/** A deterministic 512-d embedding that is `drift` away from the base direction. */
function embedding(seed, drift = 0) {
  const out = new Array(512);
  for (let i = 0; i < 512; i += 1) {
    out[i] = Math.sin(i * 0.7 + 1) + drift * Math.sin(i * 3.1 + seed);
  }
  return out;
}

const coherentSet = (n = 16) => Array.from({ length: n }, (_, i) => embedding(i, 0.05));

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('studio-lora-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;

  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, lora_trigger)
     VALUES ($1,'lora-avatar','Lora Avatar','synthetic','draft','26 year old woman','l0r4tk') RETURNING id`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;

  // Entitlements are per-PLAN, not per-tenant. The free tier is seeded at
  // `avatars 1 lifetime` in migration 030, so the per-tenant COUNTER is what
  // gets cleared between tests rather than the entitlement being overridden.
});

/**
 * Training costs credits now, so a fixture that trains has to hold some.
 *
 * These tests are about versioning, activation and tenancy, not about the
 * bill — `tests/calibration.test.js` and the credit-flow script are where the
 * charge itself is proved. Topping up in `reset()` keeps each of them testing
 * the one thing it is named for, rather than each one independently
 * rediscovering that a build is 120 credits.
 */
async function fund(credits = 1000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
    await CreditLedger.purchase(client, TENANT, credits, `test-fund:${TENANT}:${Date.now()}`, 'fixture');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

test.after(async () => {
  await pool.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

async function reset() {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatar_loras WHERE avatar_id = $1', [AVATAR]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await fund();
}

// ── Seed-set coherence ────────────────────────────────────────────────────────

test('a coherent seed set passes and yields a reference vector', () => {
  const out = LoraTraining.checkSeedCoherence(coherentSet());
  assert.ok(out.coherent);
  assert.strictEqual(out.mean.length, 512);
  assert.ok(out.average > 0.9, `expected a tight set, got ${out.average.toFixed(3)}`);
});

test('🐛 one off-model face is caught before training, not after', () => {
  // This is the failure this check exists to prevent. The seed-set mean becomes
  // the reference EVERY future frame is compared against, permanently. One
  // stranger in the set moves that reference toward a person who does not exist,
  // and every QC decision afterwards is made against the wrong face — silently,
  // and only fixable by retraining.
  const withStranger = [...coherentSet(15), embedding(99, 4.0)];
  const out = LoraTraining.checkSeedCoherence(withStranger);
  assert.strictEqual(out.coherent, false);
  assert.strictEqual(out.outliers.length, 1);
  assert.strictEqual(out.outliers[0].index, 15, 'must name WHICH image to drop, not just fail');
});

test('a seed set that is too small or too large is refused with a reason', () => {
  assert.throws(
    () => LoraTraining.checkSeedCoherence(coherentSet(6)),
    (e) => e.code === 'SEED_SET_TOO_SMALL' && /background instead of the face/.test(e.message)
  );
  assert.throws(
    () => LoraTraining.checkSeedCoherence(coherentSet(80)),
    (e) => e.code === 'SEED_SET_TOO_LARGE'
  );
});

// ── Requesting training ───────────────────────────────────────────────────────

test('training costs credits, and a workspace that cannot pay is refused cleanly', async () => {
  await reset();
  await pool.query('DELETE FROM credit_ledger WHERE tenant_id = $1', [TENANT]);

  await assert.rejects(
    () => LoraTraining.requestTraining({
      tenantId: TENANT, avatarId: AVATAR,
      seedSetUrl: 'https://cdn/seed.zip',
      seedEmbeddings: coherentSet(),
      triggerToken: 'l0r4tk',
      idempotencyKey: `broke:${Date.now()}`,
    }),
    (e) => e.code === 'NOT_ENOUGH_CREDITS' && e.status === 402
  );

  // The spend and the enqueue share one transaction, so a refusal leaves
  // neither a charge nor a job. A job queued against credits that were never
  // taken is a free training run; a charge with no job is money for nothing.
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM render_jobs WHERE tenant_id = $1 AND stage = 'lora_train'",
    [TENANT]
  );
  assert.strictEqual(rows[0].n, 0, 'a refused training must not leave a job behind');

  const { rows: led } = await pool.query(
    'SELECT count(*)::int AS n FROM credit_ledger WHERE tenant_id = $1', [TENANT]);
  assert.strictEqual(led[0].n, 0, 'nor a ledger line');

  await fund();
});

test('training is queued with the trigger, the seed ref and the mean embedding', async () => {
  await reset();
  const { job, version } = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR,
    seedSetUrl: 'https://cdn/seed.zip',
    seedEmbeddings: coherentSet(),
    triggerToken: 'l0r4tk9x',
  });

  assert.strictEqual(job.stage, 'lora_train');
  assert.strictEqual(job.runner, 'cloud');
  assert.strictEqual(version, 1);
  assert.strictEqual(job.payload.generation.trigger_word, 'l0r4tk9x');
  assert.strictEqual(job.payload.generation.images_data_url, 'https://cdn/seed.zip');
  assert.strictEqual(job.payload.face_embedding_mean.length, 512,
    'the reference vector rides on the job so completion need not re-embed the set');
  // Training outranks rendering: nothing else for this avatar can start until it lands.
  assert.ok(job.priority < 50);
});

test('an incoherent seed set is refused before a job or a bill exists', async () => {
  await reset();
  await assert.rejects(
    () => LoraTraining.requestTraining({
      tenantId: TENANT, avatarId: AVATAR,
      seedSetUrl: 'https://cdn/seed.zip',
      seedEmbeddings: [...coherentSet(15), embedding(99, 4.0)],
      triggerToken: 'l0r4tk9x',
    }),
    (e) => e.status === 409 && e.code === 'SEED_SET_INCOHERENT'
  );
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int n FROM render_jobs WHERE tenant_id = $1 AND stage = 'lora_train'", [TENANT]
  );
  assert.strictEqual(rows[0].n, 0, 'a refused request must not leave a job behind');
});

test('a trigger token must be a nonsense string, not a name', async () => {
  await reset();
  // 'aanya' is the important one: it passes any length-and-charset rule, and
  // it is exactly the token that would blend the avatar with everything the
  // base model already associates with that name.
  for (const bad of ['aanya', 'Aanya', 'a', 'a4ny4_prsn', 'x'.repeat(30), 'modelgirl']) {
    await assert.rejects(
      () => LoraTraining.requestTraining({
        tenantId: TENANT, avatarId: AVATAR,
        seedSetUrl: 'u', seedEmbeddings: coherentSet(), triggerToken: bad,
      }),
      (e) => e.code === 'BAD_TRIGGER',
      `"${bad}" should have been refused`
    );
  }
});

test('versions increment, and a retrain does not spend a second avatar slot', async () => {
  // Free tier is `avatars 1 lifetime`. Charging per training run would refuse
  // the retrain that fixes a bad first seed set.
  await reset();
  const first = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
    seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
  });
  await LoraTraining.recordTrained(first.job.id, { filePath: 'v1.safetensors', costCents: 200 });

  const second = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
    seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
  });
  assert.strictEqual(second.version, 2);
});

// ── Recording and activating ──────────────────────────────────────────────────

test('a freshly trained LoRA lands INACTIVE', async () => {
  await reset();
  const { job } = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
    seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
  });
  const lora = await LoraTraining.recordTrained(job.id, { filePath: 'https://cdn/v1.safetensors', costCents: 200 });

  assert.strictEqual(lora.active, false,
    'activating on arrival would run every frame through the permissive uncalibrated floor');
  assert.strictEqual(lora.file_path, 'https://cdn/v1.safetensors');
  assert.strictEqual(lora.seed_set_count, 16);
  assert.ok(Array.isArray(lora.face_embedding_mean));
});

test('activation is refused until the QC baselines exist', async () => {
  await reset();
  const { job } = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
    seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
  });
  const lora = await LoraTraining.recordTrained(job.id, { filePath: 'v1.safetensors' });

  await assert.rejects(
    () => LoraTraining.activate(TENANT, lora.id),
    (e) => e.status === 409 && e.code === 'NOT_CALIBRATED'
  );

  await pool.query(
    `INSERT INTO expression_baselines (avatar_id, lora_id, preset_key, framing, expected_similarity, tolerance, sample_count)
     VALUES ($1,$2,'neutral','medium',0.82,0.05,8)`,
    [AVATAR, lora.id]
  );
  const active = await LoraTraining.activate(TENANT, lora.id);
  assert.strictEqual(active.active, true);
});

test('activating v2 deactivates v1 — exactly one model per avatar', async () => {
  await reset();
  const mk = async () => {
    const { job } = await LoraTraining.requestTraining({
      tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
      seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
    });
    return LoraTraining.recordTrained(job.id, { filePath: 'x.safetensors' });
  };
  const v1 = await mk();
  const v2 = await mk();
  for (const l of [v1, v2]) {
    await pool.query(
      `INSERT INTO expression_baselines (avatar_id, lora_id, preset_key, framing, expected_similarity)
       VALUES ($1,$2,'neutral','medium',0.82)`, [AVATAR, l.id]
    );
  }

  await LoraTraining.activate(TENANT, v1.id);
  await LoraTraining.activate(TENANT, v2.id);

  const { rows } = await pool.query(
    'SELECT id, active FROM avatar_loras WHERE avatar_id = $1 ORDER BY version', [AVATAR]
  );
  assert.deepStrictEqual(rows.map((r) => r.active), [false, true],
    'two active LoRAs would make "which model made this frame" unanswerable');
});

test('another tenant cannot activate this tenant\'s model', async () => {
  await reset();
  const { job } = await LoraTraining.requestTraining({
    tenantId: TENANT, avatarId: AVATAR, seedSetUrl: 'u',
    seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
  });
  const lora = await LoraTraining.recordTrained(job.id, { filePath: 'v1.safetensors' });
  await assert.rejects(
    () => LoraTraining.activate(TENANT + 99999, lora.id),
    (e) => e.status === 404
  );
});

// ── Modes ─────────────────────────────────────────────────────────────────────

test('🔒 `reference` mode is refused by the database, not just by the app', async () => {
  // Generating a likeness of someone who is not the account holder turns on
  // identifiability, not copying. The application refusals already existed and
  // were tested — but an application guard can be bypassed by a migration, a
  // fixture, a support script or an admin tool. Migration 033 makes it a CHECK
  // constraint so there is no path that reaches it.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, identity_block, lora_trigger)
       VALUES ($1,'ref-mode','Ref','reference','26 year old woman','r3fm0d')`,
      [TENANT]
    ),
    (err) => /avatars_mode_allowed/.test(err.message)
  );
});

test('synthetic and twin remain allowed', async () => {
  for (const mode of ['synthetic', 'twin']) {
    const { rows } = await pool.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, identity_block, lora_trigger)
       VALUES ($1,$2,'Mode',$3,'26 year old woman','m0d3tk')
       ON CONFLICT (tenant_id, slug) DO UPDATE SET mode = EXCLUDED.mode
       RETURNING mode`,
      [TENANT, `mode-${mode}`, mode]
    );
    assert.strictEqual(rows[0].mode, mode);
  }
  await pool.query("DELETE FROM avatars WHERE tenant_id = $1 AND slug LIKE 'mode-%'", [TENANT]);
});

test('a twin still cannot generate without a VERIFIED consent record', async () => {
  // Removing `reference` does not relax `twin`. The subject consenting to
  // themselves is legitimate; a ticked box is still not a gate.
  const { rows } = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, identity_block, lora_trigger)
     VALUES ($1,'twin-nc','Twin','twin','26 year old woman','tw1nnc')
     ON CONFLICT (tenant_id, slug) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TENANT]
  );
  await assert.rejects(
    () => LoraTraining.requestTraining({
      tenantId: TENANT, avatarId: rows[0].id, seedSetUrl: 'u',
      seedEmbeddings: coherentSet(), triggerToken: 'l0r4tk9x',
    }),
    (e) => e.status === 403 && e.code === 'CONSENT_REQUIRED'
  );
  await pool.query("DELETE FROM avatars WHERE tenant_id = $1 AND slug = 'twin-nc'", [TENANT]);
});
