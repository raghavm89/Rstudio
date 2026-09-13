'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool        = require('../../src/config/db');
const RenderJob   = require('../../src/models/renderJob');
const StudioUsage = require('../../src/models/studioUsage');

let TENANT;

test.before(async () => {
  const { rows } = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    ['studio-test-tenant']
  );
  TENANT = rows[0].id;
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  // Content is metered in one `credits` wallet (migration 056). These are
  // machinery tests — atomic reserve, over-limit refusal, settle reconciliation,
  // summary — so they run against `credits` with a fixed 240 fixture rather than
  // the free tier's real 40, keeping the numbers below meaningful.
  await pool.query(
    `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
     VALUES (NULL,'credits',240,'month')
     ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`
  );
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query(
    `UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`
  );
  await pool.end();
});

async function enqueue(overrides = {}) {
  const client = await pool.connect();
  try {
    return await RenderJob.enqueueTx(client, {
      tenant_id: TENANT, stage: 'still', runner: 'mac', payload: {}, ...overrides,
    });
  } finally {
    client.release();
  }
}

async function clearJobs() {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
}

// ── Queue mechanics ───────────────────────────────────────────────────────────

test('enqueue then claim sets lease, worker and attempt count', async () => {
  await clearJobs();
  const queued = await enqueue({ payload: { frame: 2 } });
  assert.strictEqual(queued.status, 'queued');
  assert.strictEqual(queued.attempts, 0);

  const claimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-test-1', leaseSeconds: 60 });
  assert.strictEqual(claimed.id, queued.id);
  assert.strictEqual(claimed.status, 'claimed');
  assert.strictEqual(claimed.claimed_by, 'mac-test-1');
  assert.strictEqual(claimed.attempts, 1, 'claiming must consume an attempt');
  assert.ok(claimed.lease_expires_at instanceof Date, 'a claim without a lease can strand forever');
  assert.ok(claimed.lease_expires_at > new Date(), 'lease must be in the future');
});

test('an empty queue returns null rather than throwing', async () => {
  await clearJobs();
  assert.strictEqual(await RenderJob.claimNext({ runner: 'mac', workerId: 'w' }), null);
});

test('a worker only sees jobs for its own runner', async () => {
  await clearJobs();
  await enqueue({ runner: 'cloud' });
  assert.strictEqual(await RenderJob.claimNext({ runner: 'mac', workerId: 'w' }), null);
  assert.ok(await RenderJob.claimNext({ runner: 'cloud', workerId: 'w' }));
});

test('a worker can restrict itself to the stages it can actually run', async () => {
  await clearJobs();
  await enqueue({ stage: 'motion' });
  assert.strictEqual(
    await RenderJob.claimNext({ runner: 'mac', stages: ['still', 'qc'], workerId: 'w' }),
    null
  );
  const got = await RenderJob.claimNext({ runner: 'mac', stages: ['motion'], workerId: 'w' });
  assert.strictEqual(got.stage, 'motion');
});

test('priority beats age — paid work outranks free work in the same queue', async () => {
  await clearJobs();
  await enqueue({ priority: 100, payload: { tag: 'free' } });
  await enqueue({ priority: 50,  payload: { tag: 'paid' } });
  const first = await RenderJob.claimNext({ runner: 'mac', workerId: 'w' });
  assert.strictEqual(first.payload.tag, 'paid');
});

// ── The reason claimNext is written the way it is ─────────────────────────────

test('two workers claiming at once never receive the same job', async () => {
  await clearJobs();
  const a = await enqueue({ payload: { n: 1 } });
  const b = await enqueue({ payload: { n: 2 } });

  const [one, two] = await Promise.all([
    RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' }),
    RenderJob.claimNext({ runner: 'mac', workerId: 'mac-b' }),
  ]);

  assert.ok(one && two, 'both workers should get work when two jobs are queued');
  assert.notStrictEqual(one.id, two.id, 'FOR UPDATE SKIP LOCKED must prevent a double claim');
  assert.deepStrictEqual([one.id, two.id].sort(), [a.id, b.id].sort());
});

test('with one job and two workers, exactly one wins and the other is not blocked', async () => {
  await clearJobs();
  await enqueue();
  const results = await Promise.all([
    RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' }),
    RenderJob.claimNext({ runner: 'mac', workerId: 'mac-b' }),
  ]);
  const winners = results.filter(Boolean);
  assert.strictEqual(winners.length, 1, 'SKIP LOCKED means the loser gets null, not a wait');
});

// ── Leases ────────────────────────────────────────────────────────────────────

test('heartbeat extends the lease and marks the job running', async () => {
  await clearJobs();
  await enqueue();
  const claimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a', leaseSeconds: 30 });
  const beat = await RenderJob.heartbeat(claimed.id, 'mac-a', 600);
  assert.strictEqual(beat.status, 'running');
  assert.ok(beat.lease_expires_at > claimed.lease_expires_at, 'lease should have been pushed out');
  assert.ok(beat.started_at instanceof Date);
});

test('a worker cannot heartbeat a job it does not hold', async () => {
  await clearJobs();
  await enqueue();
  const claimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' });
  assert.strictEqual(await RenderJob.heartbeat(claimed.id, 'mac-impostor', 60), null);
});

test('an expired lease returns the job to the queue', async () => {
  await clearJobs();
  const job = await enqueue();
  await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a', leaseSeconds: 30 });
  // Simulate a laptop closing mid-render.
  await pool.query(`UPDATE render_jobs SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [job.id]);

  const reaped = await RenderJob.reapExpiredLeases();
  assert.ok(reaped.some((r) => r.id === job.id));

  const after = await RenderJob.findById(job.id);
  assert.strictEqual(after.status, 'queued');
  assert.strictEqual(after.claimed_by, null);

  const reclaimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-b' });
  assert.strictEqual(reclaimed.id, job.id, 'reaped work must be claimable again');
  assert.strictEqual(reclaimed.attempts, 2);
});

test('a job out of attempts is failed by the reaper, not looped forever', async () => {
  await clearJobs();
  const job = await enqueue({ max_attempts: 1 });
  await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a', leaseSeconds: 30 });
  await pool.query(`UPDATE render_jobs SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [job.id]);
  await RenderJob.reapExpiredLeases();
  assert.strictEqual((await RenderJob.findById(job.id)).status, 'failed');
});

// ── Completion and failure ────────────────────────────────────────────────────

test('completing records the metrics that answer the self-hosting question', async () => {
  await clearJobs();
  await enqueue({ stage: 'motion' });
  const claimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' });
  const done = await RenderJob.complete(claimed.id, 'mac-a', {
    result: { url: 's3://clip.mp4' }, seconds_generated: 15, cost_cents: 33,
  });
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(Number(done.seconds_generated), 15);
  assert.strictEqual(done.cost_cents, 33);
  assert.strictEqual(done.result.url, 's3://clip.mp4');
  assert.strictEqual(done.lease_expires_at, null);
});

test('a transient failure requeues; the last attempt fails for good', async () => {
  await clearJobs();
  const job = await enqueue({ max_attempts: 2 });

  const c1 = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' });
  const f1 = await RenderJob.fail(c1.id, 'mac-a', 'ComfyUI timed out');
  assert.strictEqual(f1.status, 'queued', 'attempts remain, so retry');

  const c2 = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' });
  const f2 = await RenderJob.fail(c2.id, 'mac-a', 'ComfyUI timed out again');
  assert.strictEqual(f2.status, 'failed', 'no attempts left');
  assert.strictEqual((await RenderJob.findById(job.id)).error, 'ComfyUI timed out again');
});

test('a permanent failure skips the retries', async () => {
  await clearJobs();
  await enqueue({ max_attempts: 5 });
  const claimed = await RenderJob.claimNext({ runner: 'mac', workerId: 'mac-a' });
  const failed = await RenderJob.fail(claimed.id, 'mac-a', 'LoRA file missing', { permanent: true });
  assert.strictEqual(failed.status, 'failed', 'retrying a missing file just burns the budget');
});

test('a retried enqueue with the same idempotency key does not double-spend', async () => {
  await clearJobs();
  const key = `test-key-${Date.now()}`;
  const first  = await enqueue({ idempotency_key: key });
  const second = await enqueue({ idempotency_key: key });
  assert.strictEqual(second.id, first.id, 'the same request must not create a second job');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM render_jobs WHERE idempotency_key = $1', [key]);
  assert.strictEqual(rows[0].n, 1);
});

// ── Quota ─────────────────────────────────────────────────────────────────────

test('the free-tier credit wallet resolves for a tenant with no subscription', async () => {
  const client = await pool.connect();
  try {
    // A tenant with no subscription is a free-tier tenant; limitFor falls back to
    // the plan_id IS NULL row. (Seeded to 240 above so the machinery tests have
    // room; the product free wallet is 40 — see migration 056.)
    assert.strictEqual(await StudioUsage.limitFor(client, TENANT, 'credits', 'month'), 240);
  } finally {
    client.release();
  }
});

test('reserving over the limit is refused AND does not consume the allowance', async () => {
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  const client = await pool.connect();
  try {
    await StudioUsage.reserve(client, TENANT, 'credits', 200);
    await assert.rejects(
      () => StudioUsage.reserve(client, TENANT, 'credits', 100),
      (err) => err.code === 'QUOTA_EXCEEDED' && err.remaining === 40
    );
    const { rows } = await client.query(
      `SELECT used FROM studio_usage_counters
        WHERE tenant_id = $1 AND metric = 'credits'
          AND period_start = date_trunc('month', NOW())::date`, [TENANT]
    );
    assert.strictEqual(Number(rows[0].used), 200, 'a refused reservation must roll itself back');
  } finally {
    client.release();
  }
});

test('settle reconciles an estimate against what was actually generated', async () => {
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  const client = await pool.connect();
  try {
    await StudioUsage.reserve(client, TENANT, 'credits', 60);
    await StudioUsage.settle(client, TENANT, 'credits', 60, 45);
    const { rows } = await client.query(
      `SELECT used FROM studio_usage_counters
        WHERE tenant_id = $1 AND metric = 'credits'
          AND period_start = date_trunc('month', NOW())::date`, [TENANT]
    );
    assert.strictEqual(Number(rows[0].used), 45, 'a shorter render should give the seconds back');
  } finally {
    client.release();
  }
});

test('concurrent reservations cannot both slip past the limit', async () => {
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  // Limit is 240. Four parallel 80s reservations: three fit, the fourth must not.
  const attempts = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      const c = await pool.connect();
      try { return await StudioUsage.reserve(c, TENANT, 'credits', 80); }
      finally { c.release(); }
    })
  );
  const ok = attempts.filter((a) => a.status === 'fulfilled').length;
  assert.strictEqual(ok, 3, `expected exactly 3 to fit in 240s, got ${ok}`);

  const { rows } = await pool.query(
    `SELECT used FROM studio_usage_counters
      WHERE tenant_id = $1 AND metric = 'credits'
        AND period_start = date_trunc('month', NOW())::date`, [TENANT]
  );
  assert.strictEqual(Number(rows[0].used), 240, 'the counter must never exceed the limit');
});

test('lifetime metrics use one bucket — one free publish, ever', async () => {
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  const client = await pool.connect();
  try {
    assert.strictEqual(await StudioUsage.limitFor(client, TENANT, 'publishes', 'lifetime'), 1);
    await StudioUsage.reserve(client, TENANT, 'publishes', 1, 'lifetime');
    await assert.rejects(
      () => StudioUsage.reserve(client, TENANT, 'publishes', 1, 'lifetime'),
      (err) => err.code === 'QUOTA_EXCEEDED'
    );
  } finally {
    client.release();
  }
});

test('usage summary reports remaining before it is spent', async () => {
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  const client = await pool.connect();
  try { await StudioUsage.reserve(client, TENANT, 'credits', 98); }
  finally { client.release(); }

  const summary = await StudioUsage.summary(TENANT);
  assert.strictEqual(summary.credits.used, 98);
  assert.strictEqual(summary.credits.limit, 240);
  assert.strictEqual(summary.credits.remaining, 142, 'this is the number the sidebar meter shows');
});
