'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pool      = require('../../src/config/db');
const RenderJob = require('../../src/models/renderJob');

/**
 * `cost_cents` exists to answer one question: at what volume does renting GPUs
 * from E2E beat paying fal per megapixel? These tests guard the two ways that
 * number can quietly lie.
 */

let TENANT;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('studio-cost-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

async function completedJob(cost, { megapixels = 1, seconds = 0 } = {}) {
  const client = await pool.connect();
  try {
    await RenderJob.enqueueTx(client, {
      tenant_id: TENANT, stage: 'still', runner: 'cloud', payload: {},
    });
  } finally {
    client.release();
  }
  // A job can only be completed by the worker holding its lease, so claim first.
  const claimed = await RenderJob.claimNext({ runner: 'cloud', stages: ['still'], workerId: 'w1' });
  return RenderJob.complete(claimed.id, 'w1', {
    result: {}, cost_cents: cost, megapixels, seconds_generated: seconds,
  });
}

test('🐛 a fractional cent survives the round trip', async () => {
  // cost_cents was INTEGER. A 1 MP still on fal is 3.5c, so every image rounded
  // to 3 or 4 — a ~14% error in a consistent direction on the most-recorded
  // number in the system. Migration 032 widened it to NUMERIC(12,4).
  const job = await completedJob(3.5);
  assert.strictEqual(job.cost_cents, 3.5, 'a 1 MP still must not round to 3 or 4');
});

test('🐛 numerics come back as numbers, not strings', async () => {
  // node-postgres returns NUMERIC as a STRING, deliberately. Left alone,
  // '3.5' + '2.2' is '3.52.2' and '10' < '9' is true — the analysis would
  // silently produce a smaller number and point the decision the wrong way.
  const job = await completedJob(2.2, { megapixels: 0, seconds: 5 });
  assert.strictEqual(typeof job.cost_cents, 'number');
  assert.strictEqual(typeof job.seconds_generated, 'number');
  assert.strictEqual(typeof job.megapixels, 'number');
});

test('costs add up rather than concatenate', async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  // A four-candidate 2 MP shoot: 4 images x 2 MP x 3.5c.
  for (let i = 0; i < 4; i += 1) await completedJob(7, { megapixels: 2 });

  const { rows } = await pool.query(
    'SELECT SUM(cost_cents) AS total FROM render_jobs WHERE tenant_id = $1', [TENANT]
  );
  assert.strictEqual(Number(rows[0].total), 28);
});

test('the two meters stay in proportion — stills and video biased differently would be worse', async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  // Integers would have rounded 3.5→4 (+14%) and 2.2→2 (−9%), so even the RATIO
  // between image and video spend would have been wrong, in opposite directions.
  const still = await completedJob(3.5, { megapixels: 1 });
  const video = await completedJob(2.2 * 5, { megapixels: 0, seconds: 5 });
  assert.strictEqual(still.cost_cents, 3.5);
  assert.strictEqual(video.cost_cents, 11);
  assert.ok(Math.abs(video.cost_cents / still.cost_cents - 3.142857) < 0.0001);
});

test('precision is bounded, not unlimited — 4dp is a tenth of a millicent', async () => {
  const job = await completedJob(0.00005);
  // Rounds at the column, which is fine and deliberate: below a tenth of a
  // millicent there is nothing to account for.
  assert.strictEqual(job.cost_cents, 0.0001);
});
