'use strict';

const pool           = require('../../config/db');
const RenderJob      = require('../../models/renderJob');
const StudioUsage    = require('../../models/studioUsage');
const SeedCandidates = require('./seedCandidates');
const SeedBatch      = require('./seedBatch');
const LoraTraining   = require('./loraTraining');
const CreditLedger   = require('./creditLedger');
const CalibrationChain = require('./calibrationChain');
const ShootAssets     = require('./shootAssets');

/**
 * What happens when a render finishes.
 *
 * This used to be the body of `POST /api/studio/jobs/:id/result`, which was
 * fine while the only thing that could finish a render was a worker on the far
 * end of an HTTP call. It is not fine now that renders also run inside this
 * process: a second copy of this logic is a second place for the quota
 * settlement, the seed-frame refund and the pool insert to drift, and the
 * failure mode of drift here is money — a frame charged twice, or a failed one
 * never refunded.
 *
 * So there is one copy, and both callers are thin:
 *
 *   • studioJobController.report  — parses a request, calls settle, renders JSON
 *   • cloudRunner                 — runs a job in-process, calls settle
 *
 * Nothing in here knows what a request or a response is.
 */

class JobResultError extends Error {
  constructor(message, { code = null, status = 500 } = {}) {
    super(message);
    this.name = 'JobResultError';
    this.code = code;
    this.status = status;
  }
}

const leaseLost = () =>
  new JobResultError('Lease lost — this job is no longer yours', { code: 'LEASE_LOST', status: 409 });

/** Stages that consume metered quota, and which meter they draw from. */
const METERED = {
  // Content pieces draw the one CREDITS wallet, priced per piece by the rate
  // card (creditCost.js). `fixed` means the charge does not reconcile against a
  // measured field the way seconds did: a video is its rate-card price whether
  // it came out 28s or 30s, so settle charges exactly what was reserved and a
  // permanent failure returns exactly that. The supplier COST is still banked
  // per job on render_jobs.cost_cents, so the self-hosting question stays a
  // query by stage — it just no longer rides a per-unit usage counter.
  still:   { metric: 'credits', period: 'month', fixed: true },
  // seed_still is deliberately ABSENT.
  //
  // It was here, drawing on `still_megapixels`, and that was wrong: this meter
  // is the month's SHOOTING budget, so setting an avatar up cost a month of
  // posts. A usable pool is about eighty frames and the whole monthly still
  // allowance is 15 on Free, 40 on Pro and 160 on Max — no plan could set up a
  // single avatar, and it is the first thing every customer must do.
  //
  // Candidate frames now come out of a per-avatar allowance
  // (`avatars.seed_frames_used`, entitlement `seed_frames`), reserved by
  // SeedBatch.reserveFrames and returned by SeedBatch.releaseFrame. They are
  // still metered — just against the avatar, not the month — and their COST is
  // still recorded below.
  // calib_still is deliberately ABSENT, for the same reason as seed_still above:
  // it must not draw on `still_megapixels`, which is the month's SHOOTING
  // budget. Billing setup to it would charge a month of posts to find out
  // whether the avatar works — the bug that was just taken out of the seed
  // path, reintroduced one step later.
  //
  // Absent from this table does NOT mean free. Calibration costs credits, at
  // `lora_calibrations` in the rate card, taken per frame by
  // `calibrationRun.submit` and returned per frame by `failed()` above. This
  // table is about monthly counters, and calibration touches none — which is
  // precisely why its refund needed its own branch rather than this one.
  //
  // Its supplier cost is still recorded — `RenderJob.complete` writes
  // `cost_cents` on every job whatever its stage — so the self-hosting question
  // is `SUM(cost_cents) WHERE stage = 'calib_still'`. There is no usage counter
  // for it on purpose: a counter nobody enforces reads like a limit and is not.
  motion:  { metric: 'credits', period: 'month', fixed: true },
  lipsync: { metric: 'credits', period: 'month', fixed: true },
  publish: { metric: 'publishes',        period: 'lifetime', field: null },
};

/** Run `fn` inside its own transaction. */
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record the outcome of one job.
 *
 * @param {number|string} jobId
 * @param {string}        workerId   whoever holds the lease — a remote worker's
 *                                   id, or this process's runner id
 * @param {object}        report     { ok, result, error, permanent,
 *                                     seconds_generated, megapixels, cost_cents }
 * @returns {Promise<object>} the job row as it now stands
 * @throws  {JobResultError} 404 when there is no such job, 409 when the lease
 *                           has been reaped out from under the caller
 */
async function settle(jobId, workerId, report = {}) {
  const { ok, result = {}, error = null, permanent = false,
          seconds_generated = 0, megapixels = 0, cost_cents = 0 } = report;

  if (typeof ok !== 'boolean') {
    throw new JobResultError('ok (boolean) is required', { status: 400 });
  }

  const existing = await RenderJob.findById(jobId);
  if (!existing) throw new JobResultError('Job not found', { status: 404 });
  if (existing.claimed_by !== workerId) throw leaseLost();

  return ok
    ? completed(existing, workerId, { result, seconds_generated, megapixels, cost_cents })
    : failed(existing, workerId, { error, permanent });
}

// ── The unhappy path ─────────────────────────────────────────────────────────

async function failed(existing, workerId, { error, permanent }) {
  const job = await RenderJob.fail(existing.id, workerId, String(error || 'unknown error'), { permanent });
  if (!job) throw leaseLost();

  /**
   * A seed frame that failed returns what it took.
   *
   * Its allowance is on the avatar and its credits are in the ledger, neither
   * of which `METERED` knows about — seed_still is deliberately absent from it.
   * Without this a frame fal refused would still be charged, which makes
   * failures profitable, and a batch with a bad run would quietly eat an
   * avatar's whole included set.
   */
  if (job.status === 'failed' && job.stage === 'seed_still') {
    const p = existing.payload || {};
    await inTransaction((client) => SeedBatch.releaseFrame(client, {
      tenantId: job.tenant_id,
      avatarId: Number(p.avatar_id),
      fromPlan: Number(p._seed_plan || 0),
      fromCredits: Number(p._from_credits || 0),
      reference: `job:${job.id}`,
    }));
  }

  /**
   * A build step that failed permanently returns its credits.
   *
   * `lora_train` and `calib_still` take credits and touch no monthly counter,
   * so `METERED` below cannot give them back — it only knows about metrics.
   * Without this, a training run fal refused would still be charged 120
   * credits, which makes failures profitable, and a calibration that died at
   * frame forty would keep the whole run's money.
   *
   * `job.status === 'failed'` is the permanence check, same as everywhere here:
   * a requeued attempt keeps its charge, because it is going to run.
   */
  if (job.status === 'failed' && ['lora_train', 'calib_still'].includes(job.stage)) {
    const taken = Number(existing.payload?._from_credits || 0);
    if (taken > 0) {
      await inTransaction((client) => CreditLedger.refund(
        client, job.tenant_id, taken, `job:${job.id}`,
        `${job.stage} failed — credits returned`));
    }
  }

  // A permanently failed job releases the quota it reserved. A requeued one
  // keeps it — the attempt will be retried and will cost again. For a fixed
  // credit piece the reserved amount IS the charge, so releasing it (actual = 0)
  // returns the whole piece, and settle refunds its share of any purchased
  // credits alongside.
  const meter = METERED[job.stage];
  if (meter && (meter.field || meter.fixed) && job.status === 'failed') {
    await inTransaction((client) => StudioUsage.settle(
      client, job.tenant_id, meter.metric,
      Number(existing.payload?._reserved || 0), 0, meter.period,
      { fromCredits: Number(existing.payload?._from_credits || 0), reference: `job:${job.id}` }
    ));
  }

  return job;
}

// ── The happy path ───────────────────────────────────────────────────────────

async function completed(existing, workerId, { result, seconds_generated, megapixels, cost_cents }) {
  const done = await inTransaction(async (client) => {
    const job = await RenderJob.complete(existing.id, workerId, {
      result, seconds_generated, megapixels, cost_cents,
    });
    if (!job) throw leaseLost();

    // Reconcile the estimate against what it really used, and bank the cost so
    // the self-hosting decision is a query rather than a guess.
    const meter = METERED[job.stage];
    if (meter && (meter.field || meter.fixed)) {
      // A fixed credit piece is charged exactly what it reserved — the rate-card
      // price does not move with the seconds or megapixels it happened to
      // produce. A metered (field) stage still reconciles estimate vs actual.
      const reserved = Number(existing.payload?._reserved || 0);
      const actual   = meter.fixed ? reserved : Number(job[meter.field] || 0);
      await StudioUsage.settle(
        client, job.tenant_id, meter.metric,
        reserved, actual, meter.period,
        { fromCredits: Number(existing.payload?._from_credits || 0), reference: `job:${job.id}` }
      );
      // Bank the supplier cost on the wallet counter so margin stays a query.
      // Per-stage cost lives on render_jobs.cost_cents (written on every job),
      // which is where the self-hosting breakdown by stage is read.
      await StudioUsage.addCost(client, job.tenant_id, meter.metric, Number(cost_cents || 0), meter.period);
    }
    return job;
  });

  // Everything below is OUTSIDE the transaction on purpose — the job IS
  // complete either way, and a failure to record must not roll back the
  // completion and hand the same job back to be paid for twice.
  await recordArtefacts(existing, done, result, cost_cents);
  return done;
}

/**
 * A finished job is not the same as a recorded result.
 *
 * `lora_train` produces an artefact the rest of the product needs a ROW for —
 * `avatar_loras` is what calibrate, activate and every future shoot look the
 * model up in. Candidate frames, for the same reason: the job finishing is not
 * the same as the frame being in the pool. Without this the bytes sit in
 * storage, the money is spent, and the culling screen says "no photos yet".
 */
async function recordArtefacts(existing, done, result, cost_cents) {
  // A finished shoot still: record its frames as studio_assets and hand the
  // first to this shot's motion job (image-to-video input). QC-based selection
  // of the best candidate is a separate stage; this only records and wires.
  if (done.stage === 'still') {
    const client = await pool.connect();
    try {
      const out = await ShootAssets.recordStillAndFeedMotion(client, { existing, done, result });
      console.log(`[job ${done.id}] recorded ${out.assets} still asset(s)` + (out.motionFed ? ', fed motion' : ''));
    } catch (err) {
      console.error(`[job ${done.id}] still finished but asset/motion wiring failed: ${err.message}`);
    } finally {
      client.release();
    }
    return;
  }

  if (done.stage === 'seed_still') {
    const p = existing.payload || {};
    const assets = result.assets || [];
    if (!assets.length) {
      console.error(`[job ${done.id}] seed frame reported no asset — nothing added to the pool`);
      return;
    }
    const client = await pool.connect();
    try {
      for (const [i, asset] of assets.entries()) {
        await SeedCandidates.recordGenerated(client, {
          avatarId: Number(p.avatar_id),
          // The label, not the worker's filename: `<prefix>-1.png` is what the
          // worker writes, and the pool is keyed on something stable.
          filename: assets.length === 1 ? `${p.idx}-${asset.filename}` : `${p.idx}-${i}-${asset.filename}`,
          idx: Number(p.idx),
          // The axes come off the JOB's own cell rather than out of the
          // filename. The local path parses the name because a directory has
          // nowhere else to keep them; a queued job carries the cell it was
          // planned for, and re-deriving it from a string the worker composed
          // would be inventing a way to be wrong.
          cell: p.cell || {},
          seed: result.seed,
          storageKey: asset.key || asset.url || null,
          jobId: done.id,
          batch: p.batch || null,
          // anchor or pool. Off the job, like the cell: the frame does not know
          // what it was for, and re-deriving it from the batch prefix would be
          // inventing a second way to be wrong.
          kind: p.kind === 'anchor' ? 'anchor' : 'pool',
        });
      }
      console.log(`[job ${done.id}] ${assets.length} candidate frame(s) added to batch ${p.batch}`);
    } catch (err) {
      console.error(`[job ${done.id}] frame generated but not recorded: ${err.message}`);
    } finally {
      client.release();
    }
    return;
  }

  /**
   * A calibration frame, and the step after it.
   *
   * There is no row to write — the frame is not a candidate and not a model —
   * but there IS a next step, and settlement is the only thing that reliably
   * knows this one finished. Driven from a read instead, the chain would
   * advance only while somebody had the tab open, and stop between steps
   * looking exactly like nothing was happening.
   */
  if (done.stage === 'calib_still') {
    await CalibrationChain.afterFrame(done);
    return;
  }

  if (done.stage === 'embed') {
    // Only its own. An embed job for a seed set is measured by the training
    // screen and must not be written into anybody's baselines; the flag is on
    // the payload rather than inferred from the shape of it.
    await CalibrationChain.afterEmbed(done);
    return;
  }

  if (done.stage === 'lora_train') {
    const asset = (result.assets || [])[0] || {};
    const filePath = asset.key || asset.url || null;
    if (!filePath) {
      console.error(`[job ${done.id}] trained but reported no asset — no LoRA row written`);
      return;
    }
    try {
      const lora = await LoraTraining.recordTrained(done.id, {
        filePath,
        costCents: Number(cost_cents || 0),
      });
      console.log(`[job ${done.id}] LoRA #${lora.id} v${lora.version} recorded (inactive)`);
    } catch (err) {
      console.error(`[job ${done.id}] could not record the trained LoRA: ${err.message}`);
    }
  }
}

module.exports = { settle, METERED, JobResultError };
