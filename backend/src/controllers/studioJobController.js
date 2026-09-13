'use strict';

const pool        = require('../config/db');
const RenderJob   = require('../models/renderJob');
const StudioUsage = require('../models/studioUsage');
const JobResult = require('../services/studio/jobResult');
const { creditCostFor } = require('../services/studio/creditCost');
const JobUpload = require('../services/studio/jobUpload');

/**
 * Studio queue endpoints.
 *
 * Two audiences on one table:
 *   • people  — enqueue work, watch progress   (authenticate + tenant scope)
 *   • workers — claim, heartbeat, report       (workerAuth, no tenant identity)
 *
 * The split matters. A worker holds a shared secret that lives on a laptop; it
 * must never be able to read a tenant's content, so worker routes return only
 * the job envelope and never join out to posts or assets.
 */

const RUNNERS = ['mac', 'cloud', 'server'];
const STAGES = [
  'brief', 'prompt', 'still', 'qc', 'motion', 'voice',
  'lipsync', 'assemble', 'copy', 'publish', 'insights',
  // Training was added later and never reached this list, so a `lora_train` job
  // could be ENQUEUED but never CLAIMED — the worker asking for it was refused
  // with "Unknown stage", and the job sat in the queue looking like nobody had
  // started work. Enqueue and claim have to agree on the vocabulary; they are
  // two ends of the same contract.
  'lora_train',
  // Candidate frames for a seed set. A separate stage from `still` rather than a
  // flag on it, because every other still REQUIRES an active LoRA — the provider
  // refuses without one and so does prompt assembly — and those guards are what
  // stop a shoot rendering somebody else's face. This is the one step that runs
  // before a LoRA exists, so it gets its own name instead of a hole in three
  // guards.
  'seed_still',
  // Face embeddings for the seed set, computed before training is submitted.
  //
  // Not a render: no provider, no artifact, no fal. It exists as a STAGE rather
  // than as work the API does inline because it runs insightface through a
  // Python subprocess — present on a machine somebody develops on, absent from
  // any normal Node host — and the queue is how this system already moves work
  // to a machine that can do it.
  //
  // Deliberately absent from METERED for the same reason `seed_still` is
  // present in it: metering exists to bill what a provider charges, and nobody
  // charges for this. It costs the electricity of whatever laptop runs it.
  'embed',
  // Frames generated to measure the QC gate, before the model that made them
  // is allowed to render anything that publishes.
  //
  // It is the same render as `still` against the same endpoint, and it is a
  // separate stage anyway, because `still` is metered against
  // `still_megapixels` — the month's SHOOTING budget. Billing forty frames of
  // setup to it is the bug that took seed frames out of that meter, one step
  // later in the same sequence. Absent from METERED entirely: calibration is
  // the second half of training, and training is included.
  //
  // Listed here because enqueue and claim have to agree on the vocabulary. The
  // comment on `lora_train` above is the record of what happens when they do
  // not: the job queues, no worker may claim it, and it reads to the customer
  // as nobody having started.
  'calib_still',
];

/**
 * Stages that consume metered quota, and which meter they draw from.
 *
 * Defined in the settlement service, because that is the only thing that reads
 * it and it must mean the same thing whether a render finished over HTTP or in
 * this process. Re-exported here because it is part of this module's published
 * contract and tests/studio/stageContract.test.js checks it against STAGES.
 */
const { METERED } = require('../services/studio/jobResult');

// ── People ────────────────────────────────────────────────────────────────────

// POST /api/studio/jobs
// Enqueue one stage. Quota is reserved in the SAME transaction as the insert, so
// a refused check cannot leave a queued job behind.
exports.enqueue = async (req, res) => {
  const { stage, runner = 'server', project_id = null, shot_id = null, post_id = null,
          provider = null, payload = {}, estimate = 0, idempotency_key = null } = req.body;

  if (!STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of ${STAGES.join(', ')}` });
  }
  if (!RUNNERS.includes(runner)) {
    return res.status(400).json({ error: `runner must be one of ${RUNNERS.join(', ')}` });
  }
  if (!Number.isFinite(Number(estimate)) || Number(estimate) < 0) {
    return res.status(400).json({ error: 'estimate must be a non-negative number' });
  }

  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });

  const meter = METERED[stage];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let reserved = 0;
    // How much of the reservation was paid for out of PURCHASED credits rather
    // than the plan allowance. Carried on the job so that settling it later can
    // return the unused part — a number the job has to remember, because by the
    // time it finishes the counters have moved on.
    let fromCredits = 0;
    if (meter) {
      // A credit piece costs what the rate card says (creditCost.js): a still is
      // 1, a generative clip is its seconds at the resolution's rate, a lipsync
      // is flat by tier. A per-unit metered stage still reserves its estimate; a
      // lifetime marker (publish) reserves one.
      const amount = meter.metric === 'credits'
        ? creditCostFor({
            stage,
            seconds:     Number(estimate) || 0,
            resolution:  payload.resolution,
            lipsyncTier: payload.lipsync_tier,
          })
        : (meter.field ? Number(estimate) : 1);
      const taken = await StudioUsage.reserve(client, tenantId, meter.metric, amount, meter.period);
      reserved = amount;
      fromCredits = Number(taken?.from_credits || 0);
    }

    const job = await RenderJob.enqueueTx(client, {
      tenant_id: tenantId,
      project_id, shot_id, post_id,
      stage, runner, provider,
      // Paid work outranks free work in the same queue.
      priority: req.user.plan_id ? 50 : 100,
      payload: { ...payload, _reserved: reserved, _from_credits: fromCredits },
      idempotency_key,
    });

    await client.query('COMMIT');
    return res.status(201).json({ job });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({
        error: err.message,
        code: err.code,
        metric: err.metric,
        remaining: err.remaining,
        limit: err.limit,
      });
    }
    throw err;
  } finally {
    client.release();
  }
};

// GET /api/studio/jobs/:id
exports.get = async (req, res) => {
  const job = await RenderJob.findById(req.params.id);
  if (!job || job.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ job });
};

// GET /api/studio/projects/:id/jobs — what the progress view polls
exports.listForProject = async (req, res) => {
  const jobs = await RenderJob.listForProject(req.user.tenant_id, req.params.id);
  res.json({ jobs });
};

// GET /api/studio/usage — the sidebar meter
exports.usage = async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: 'No tenant on this account' });
  // Credits are computed from the same summary rather than sent as a separate
  // number the client has to reconcile — one read, one answer.
  const summary = await StudioUsage.summary(req.user.tenant_id);
  const { creditPosition } = require('../services/studio/credits');
  res.json({ usage: summary, credits: creditPosition(summary) });
};

// ── Workers ───────────────────────────────────────────────────────────────────

// GET /api/studio/jobs/next?runner=mac&stages=still,qc
// 204 when the queue is empty, so a polling worker can treat "nothing to do" as
// a normal response rather than an error to back off from.
exports.claimNext = async (req, res) => {
  const runner = req.query.runner;
  if (!RUNNERS.includes(runner)) {
    return res.status(400).json({ error: `runner must be one of ${RUNNERS.join(', ')}` });
  }

  let stages = null;
  if (req.query.stages) {
    stages = String(req.query.stages).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = stages.filter((s) => !STAGES.includes(s));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown stage(s): ${unknown.join(', ')}` });
    }
  }

  const leaseSeconds = Math.min(Math.max(parseInt(req.query.lease, 10) || 300, 30), 3600);

  const job = await RenderJob.claimNext({
    runner, stages, workerId: req.worker.id, leaseSeconds,
  });

  if (!job) return res.sendStatus(204);
  res.json({ job, lease_seconds: leaseSeconds });
};

// POST /api/studio/jobs/:id/heartbeat
exports.heartbeat = async (req, res) => {
  const leaseSeconds = Math.min(Math.max(parseInt(req.body.lease_seconds, 10) || 300, 30), 3600);
  const job = await RenderJob.heartbeat(req.params.id, req.worker.id, leaseSeconds);
  if (!job) {
    // The lease was reaped and the job requeued while this worker was busy.
    // Telling it plainly is what lets it abandon the work instead of finishing
    // a render nobody is waiting for.
    return res.status(409).json({ error: 'Lease lost — this job is no longer yours', code: 'LEASE_LOST' });
  }
  res.json({ job });
};

// POST /api/studio/jobs/:id/result
// { ok: true,  result, seconds_generated, megapixels, cost_cents }
// { ok: false, error, permanent }
exports.report = async (req, res) => {
  try {
    const job = await JobResult.settle(req.params.id, req.worker.id, req.body);
    return res.json({ job });
  } catch (err) {
    // A settlement refusal is an answer, not a crash: the worker needs to know
    // whether to abandon the job (LEASE_LOST) or that it reported against
    // something that does not exist. Anything else is ours and goes up.
    if (err.name !== 'JobResultError') throw err;
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    return res.status(err.status || 500).json(body);
  }
};

// POST /api/studio/jobs/reap — idempotent, safe to call on a timer
exports.reap = async (req, res) => {
  const reaped = await RenderJob.reapExpiredLeases();
  res.json({ reaped: reaped.length, jobs: reaped });
};

/**
 * Content types a worker may upload.
 *
 * Objects in this bucket are served from a public https address, because
 * Instagram's Content Publishing API fetches media from a URL rather than
 * accepting an upload. That makes an unrestricted upload endpoint a stored-XSS
 * primitive on our own domain: a leaked worker token could PUT an .html file and
 * get it served, with a signature we minted.
 *
 * The worker grant is deliberately narrow — a leaked worker token should cost
 * renders, not data — and this is part of that boundary.
 */
// POST /api/studio/jobs/:id/upload-target
// { filename, contentType, kind } -> a presigned PUT scoped to this job's tenant.
//
// The worker supplies a filename and a type. It does NOT supply a key — the key
// is derived from the JOB's tenant, avatar and project, in JobUpload, which the
// in-process runner derives its keys through as well.
exports.uploadTarget = async (req, res) => {
  const job = await RenderJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.claimed_by !== req.worker.id) {
    return res.status(409).json({ error: 'Lease lost — this job is no longer yours', code: 'LEASE_LOST' });
  }

  try {
    return res.json(await JobUpload.targetFor(job, req.body));
  } catch (err) {
    if (err.name !== 'JobResultError') throw err;
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    return res.status(err.status || 500).json(body);
  }
};

exports.STAGES = STAGES;
exports.RUNNERS = RUNNERS;
exports.METERED = METERED;
