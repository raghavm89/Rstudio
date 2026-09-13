'use strict';

const pool = require('../config/db');

/**
 * Coerce Postgres NUMERIC columns back to JS numbers.
 *
 * node-postgres returns NUMERIC as a STRING, deliberately: arbitrary-precision
 * decimals do not survive a float. That is the right default for money in
 * general, and wrong for these three columns in particular — they are bounded
 * (cents to 4dp, seconds to 2dp, megapixels to 3dp) and every consumer treats
 * them as numbers.
 *
 * Leaving them as strings is not a cosmetic problem. `cost_cents` is summed to
 * answer "at what volume does renting GPUs beat paying per megapixel", and
 * '3.5' + '2.2' is '3.52.2'. A comparison is worse still: '10' < '9' is true.
 * The bug would not throw; it would quietly produce a smaller number and point
 * the self-hosting decision the wrong way.
 *
 * Applied at the model boundary so nothing downstream has to remember.
 */
const NUMERIC_COLUMNS = ['cost_cents', 'seconds_generated', 'megapixels'];

function hydrate(row) {
  if (!row) return row;
  for (const col of NUMERIC_COLUMNS) {
    if (row[col] !== undefined && row[col] !== null) row[col] = Number(row[col]);
  }
  return row;
}

const hydrateAll = (rows) => rows.map(hydrate);


/**
 * RenderJob — the Studio queue.
 *
 * One row per STAGE per unit of work, so a failure resumes from the last good
 * stage rather than restarting the shoot, and the Mac worker can go offline
 * without losing anything.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, which is what lets several workers
 * poll the same queue without ever handing the same job to two of them and
 * without one worker blocking another. Every claim takes a LEASE; if a worker
 * dies mid-job the lease expires and `reapExpiredLeases` returns the work to the
 * queue. Without the lease, a laptop that closes mid-render strands the job
 * forever in `claimed`.
 */
const RenderJob = {
  /**
   * Claim the next queued job for a runner.
   *
   * The CTE selects one candidate row and locks it; SKIP LOCKED makes concurrent
   * pollers step over rows another transaction already holds instead of queuing
   * behind them. The UPDATE then flips it to `claimed` in the same statement, so
   * there is no window in which a claimed job looks available.
   *
   * @returns {object|null} the claimed job, or null when the queue is empty
   */
  async claimNext({ runner, stages = null, workerId, leaseSeconds = 300 }) {
    const { rows } = await pool.query(
      `WITH candidate AS (
         SELECT j.id
           FROM render_jobs j
          WHERE j.status = 'queued'
            AND j.runner = $1
            AND ($2::text[] IS NULL OR j.stage = ANY($2::text[]))
            AND j.attempts < j.max_attempts
            -- A job whose upstream stages have not finished is not eligible.
            -- Checked here rather than by a scheduler, so there is no window in
            -- which an unready job can be handed to a worker.
            AND NOT EXISTS (
              SELECT 1 FROM render_jobs d
               WHERE d.id = ANY(j.depends_on)
                 AND d.status <> 'done'
            )
          ORDER BY j.priority ASC, j.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE render_jobs j
          SET status           = 'claimed',
              claimed_by       = $3,
              claimed_at       = NOW(),
              lease_expires_at = NOW() + make_interval(secs => $4::int),
              attempts         = j.attempts + 1,
              updated_at       = NOW()
         FROM candidate c
        WHERE j.id = c.id
      RETURNING j.*`,
      [runner, stages, workerId, leaseSeconds]
    );
    return hydrate(rows[0]) || null;
  },

  /** Long renders extend their own lease so the reaper does not steal them. */
  async heartbeat(id, workerId, leaseSeconds = 300) {
    const { rows } = await pool.query(
      `UPDATE render_jobs
          SET status           = 'running',
              lease_expires_at = NOW() + make_interval(secs => $3::int),
              started_at       = COALESCE(started_at, NOW()),
              updated_at       = NOW()
        WHERE id = $1
          AND claimed_by = $2
          AND status IN ('claimed', 'running')
      RETURNING *`,
      [id, workerId, leaseSeconds]
    );
    return hydrate(rows[0]) || null;
  },

  /**
   * Complete a job and record what it actually cost.
   *
   * The metrics are not decoration. When the self-hosting question comes back at
   * scale the answer is a query over these columns rather than an estimate:
   *   break-even throughput = gpu_hourly_rate / api_per_second_rate
   */
  async complete(id, workerId, { result = {}, seconds_generated = 0, megapixels = 0, cost_cents = 0 } = {}) {
    const { rows } = await pool.query(
      `UPDATE render_jobs
          SET status            = 'done',
              result            = $3::jsonb,
              seconds_generated = $4,
              megapixels        = $5,
              cost_cents        = $6,
              finished_at       = NOW(),
              lease_expires_at  = NULL,
              error             = NULL,
              updated_at        = NOW()
        WHERE id = $1
          AND claimed_by = $2
          AND status IN ('claimed', 'running')
      RETURNING *`,
      [id, workerId, JSON.stringify(result), seconds_generated, megapixels, cost_cents]
    );
    return hydrate(rows[0]) || null;
  },

  /**
   * Fail a job. Requeues while attempts remain, otherwise marks it failed.
   *
   * `permanent` short-circuits the retry for errors that will never succeed on a
   * second attempt — a malformed workflow, a missing LoRA file. Retrying those
   * just burns the attempt budget and delays the real error reaching the user.
   */
  async fail(id, workerId, errorMessage, { permanent = false } = {}) {
    const { rows } = await pool.query(
      `UPDATE render_jobs
          SET status = CASE
                WHEN $4::boolean OR attempts >= max_attempts THEN 'failed'
                ELSE 'queued'
              END,
              error            = $3,
              claimed_by       = NULL,
              claimed_at       = NULL,
              lease_expires_at = NULL,
              finished_at      = CASE
                WHEN $4::boolean OR attempts >= max_attempts THEN NOW()
                ELSE NULL
              END,
              updated_at       = NOW()
        WHERE id = $1
          AND claimed_by = $2
          AND status IN ('claimed', 'running')
      RETURNING *`,
      [id, workerId, errorMessage, permanent]
    );
    return hydrate(rows[0]) || null;
  },

  /**
   * Return work stranded by a worker that stopped reporting.
   *
   * Run on an interval. A closed laptop mid-render is the ordinary case, not the
   * exceptional one, which is why the lease exists at all.
   */
  async reapExpiredLeases() {
    const { rows } = await pool.query(
      `UPDATE render_jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              error  = CASE
                WHEN attempts >= max_attempts
                  THEN 'Lease expired and no attempts remain — worker stopped reporting'
                ELSE 'Lease expired — worker stopped reporting, requeued'
              END,
              claimed_by       = NULL,
              claimed_at       = NULL,
              lease_expires_at = NULL,
              updated_at       = NOW()
        WHERE status IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < NOW()
      RETURNING id, status, attempts`,
      []
    );
    return hydrateAll(rows);
  },

  /**
   * Mark everything downstream of a permanently failed job as blocked.
   *
   * Without this, dependents sit in `queued` forever waiting on a job that will
   * never reach `done` — invisible in the UI, invisible in the queue depth, and
   * eventually confusing. `blocked` also carries better information than
   * `failed`: "skipped because frame 3 failed" beats nine identical failures.
   *
   * Recursive, because a chain is more than two deep — a blocked assemble stage
   * must in turn block the publish stage waiting on it.
   */
  async blockDependentsTx(client, failedId) {
    const { rows } = await client.query(
      `WITH RECURSIVE downstream AS (
         SELECT id FROM render_jobs WHERE $1 = ANY(depends_on)
         UNION
         SELECT j.id FROM render_jobs j
           JOIN downstream d ON d.id = ANY(j.depends_on)
       )
       UPDATE render_jobs
          SET status      = 'blocked',
              error       = COALESCE(error, 'Skipped — an upstream stage failed'),
              finished_at = NOW(),
              updated_at  = NOW()
        WHERE id IN (SELECT id FROM downstream)
          AND status IN ('queued', 'claimed', 'running')
      RETURNING id, stage`,
      [failedId]
    );
    return hydrateAll(rows);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM render_jobs WHERE id = $1', [id]);
    return hydrate(rows[0]) || null;
  },

  /** Jobs for one project, oldest first — what the progress view polls. */
  async listForProject(tenantId, projectId) {
    const { rows } = await pool.query(
      `SELECT * FROM render_jobs
        WHERE tenant_id = $1 AND project_id = $2
        ORDER BY created_at ASC`,
      [tenantId, projectId]
    );
    return hydrateAll(rows);
  },

  /**
   * Enqueue inside an existing transaction.
   *
   * Takes a client rather than the pool on purpose: enqueueing and reserving
   * quota must commit together, or a user can queue work the entitlement check
   * already refused.
   */
  async enqueueTx(client, {
    tenant_id, project_id = null, shot_id = null, post_id = null,
    stage, runner = 'server', provider = null, priority = 100,
    payload = {}, max_attempts = 3, idempotency_key = null,
    depends_on = [], step_index = null, step_total = null, label = null,
  }) {
    const { rows } = await client.query(
      `INSERT INTO render_jobs
         (tenant_id, project_id, shot_id, post_id, stage, runner, provider,
          priority, payload, max_attempts, idempotency_key,
          depends_on, step_index, step_total, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::int[],$13,$14,$15)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
       RETURNING *`,
      [
        tenant_id, project_id, shot_id, post_id, stage, runner, provider,
        priority, JSON.stringify(payload), max_attempts, idempotency_key,
        depends_on, step_index, step_total, label,
      ]
    );
    // A conflict means this exact request already produced a job. Return the
    // original rather than a second one — a retried "generate" must never
    // double-spend the customer's quota.
    if (!rows[0] && idempotency_key) {
      const existing = await client.query(
        'SELECT * FROM render_jobs WHERE idempotency_key = $1',
        [idempotency_key]
      );
      return hydrate(existing.rows[0]) || null;
    }
    return hydrate(rows[0]) || null;
  },
};

module.exports = RenderJob;
module.exports.hydrate = hydrate;
