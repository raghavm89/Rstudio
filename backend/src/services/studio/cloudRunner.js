'use strict';

const RenderJob = require('../../models/renderJob');
const JobResult = require('./jobResult');
const JobUpload = require('./jobUpload');
const { kindForStage } = require('./stageKinds');

/**
 * Runs the `cloud` stages in the API process.
 *
 * The render worker was written for a Mac holding Flux, a video model and a
 * lipsync model, and every decision in it follows from that: it polls outward
 * so a laptop needs no public address, it runs one job at a time because 36 GB
 * cannot hold three models, and it never touches the database because it holds
 * a secret that lives on somebody's desk.
 *
 * None of that describes a fal render. On fal there is no model resident
 * anywhere near us — the whole job is an HTTPS request and a wait — so a second
 * process to make that request is a second thing to keep alive, and the way it
 * fails is silent: jobs queue, the screen counts zero of twenty-four, and
 * nothing anywhere says the reason is that nobody ran a command.
 *
 * So cloud stages run here, claimed through the same queue with the same lease
 * semantics as everything else. Same claiming path means the same guarantees:
 * two API instances cannot both take one job, and a crashed instance's work is
 * reaped rather than lost.
 *
 * Three differences from the ServerRunner next door:
 *
 *   • IT RUNS SEVERAL AT ONCE. Waiting on fal is not work. One at a time would
 *     make a 24-frame batch take 24 renders end to end — a quarter of an hour
 *     of somebody watching a progress bar for no reason.
 *   • IT HEARTBEATS. A fal render outlives a sane lease, so each in-flight job
 *     renews its own.
 *   • IT CHECKS THE PROVIDER BEFORE IT CLAIMS. Claiming work it cannot start
 *     burns an attempt and strands the job for a lease period.
 *
 * worker/index.js is still the way to run stages on a GPU you own; this does
 * not replace it, it just means nobody has to start anything to use fal.
 */

/**
 * A number from the environment, clamped.
 *
 * `parseInt(x, 10) || fallback` is the usual spelling and it is wrong for
 * anything whose zero is meaningful: STUDIO_CLOUD_CONCURRENCY=0 reads as
 * "don't render" to the person typing it and comes back as the default 3.
 * A deliberate zero clamps to one instead — someone who wants none of this
 * has STUDIO_CLOUD_RUNNER=off, and one render at a time is at least visible,
 * where rendering nothing at all is the exact silence this whole change is
 * about removing.
 */
function intEnv(name, fallback, lo, hi) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
}

const DEFAULTS = {
  workerId:     process.env.STUDIO_CLOUD_WORKER_ID || `api-cloud-${require('os').hostname()}-${process.pid}`,
  concurrency:  intEnv('STUDIO_CLOUD_CONCURRENCY', 3, 1, 12),
  leaseSeconds: intEnv('STUDIO_CLOUD_LEASE_SECONDS', 300, 60, 3600),
  // A floor, so a mistyped poll interval cannot turn an idle queue into a spin.
  idlePollMs:   intEnv('STUDIO_CLOUD_POLL_MS', 3000, 250, 300_000),
};

/** Lazily built, so requiring this module never constructs a provider. */
function buildProvider() {
  const { FalProvider } = require('../../../worker/providers/fal');
  return new FalProvider();
}

/**
 * Which stages this may claim.
 *
 * Asked of the provider rather than listed here. A stage fal cannot run is one
 * this must not claim: the job would be failed as UNSUPPORTED_STAGE, which is
 * permanent, which means a frame somebody paid for is gone rather than waiting
 * for the worker that could have run it.
 */
function stagesFor(provider) {
  const { ENDPOINTS } = require('../../../worker/providers/fal');
  return Object.keys(ENDPOINTS).filter((stage) => provider.supports(stage));
}

const CloudRunner = {
  DEFAULTS,

  /**
   * Run one job to completion and settle it.
   *
   * Exported separately from the loop so a test can drive a single job, and so
   * this reads as what it is: claim, render, store, settle.
   */
  async runJob(provider, job, { workerId, leaseSeconds }) {
    const started = Date.now();
    let lost = false;

    // A third of the lease, so two consecutive misses still leave room before
    // the reaper takes the job.
    const beat = setInterval(async () => {
      try {
        const alive = await RenderJob.heartbeat(job.id, workerId, leaseSeconds);
        if (!alive) throw new Error('lease lost');
      } catch (err) {
        lost = true;
        clearInterval(beat);
        console.warn(`[studio/cloudRunner] job ${job.id}: lease lost — abandoning`);
      }
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));

    try {
      const { artifacts, meta } = await provider.run(job, {
        onProgress: async () => {
          if (lost) throw Object.assign(new Error('Lease lost'), { permanent: true });
        },
      });

      // Store only after the lease is known good. Writing bytes for a job that
      // was reaped ten minutes ago spends time on an object nothing will
      // reference — the row that would have pointed at it is already requeued.
      if (lost) return null;

      const assets = [];
      for (const artifact of artifacts) {
        assets.push(await JobUpload.store(job, artifact, { kind: kindForStage(job.stage) }));
      }

      if (lost) return null;

      const done = await JobResult.settle(job.id, workerId, {
        ok: true,
        result: { ...meta, assets, elapsed_ms: Date.now() - started },
        megapixels: Number(meta.megapixels || 0),
        seconds_generated: Number(meta.seconds_generated || 0),
        cost_cents: Number(meta.cost_cents || 0),
      });
      console.log(
        `[studio/cloudRunner] job ${job.id} done — ${assets.length} asset(s), ` +
        `${Math.round((Date.now() - started) / 1000)}s, ${Number(meta.cost_cents || 0).toFixed(2)}c`
      );
      return done;
    } catch (err) {
      if (lost) return null;
      // Every provider marks its own errors. An unmarked error is something we
      // did not anticipate, and the safe reading of "unanticipated" is that a
      // retry might work — a wrong `permanent` strands a job that would have
      // succeeded.
      const permanent = err.permanent === true;
      console.error(`[studio/cloudRunner] job ${job.id} failed (${permanent ? 'permanent' : 'will retry'}): ${err.message}`);
      try {
        return await JobResult.settle(job.id, workerId, { ok: false, error: err.message, permanent });
      } catch (settleErr) {
        // Nothing more to do — the lease expires and the reaper requeues it.
        console.error(`[studio/cloudRunner] job ${job.id}: could not record the failure: ${settleErr.message}`);
        return null;
      }
    } finally {
      clearInterval(beat);
    }
  },

  /**
   * Claim and run at most one job. Returns the job, or null when idle or when
   * the provider is not ready.
   */
  async tick({ provider = this._provider || (this._provider = buildProvider()),
               workerId = DEFAULTS.workerId,
               leaseSeconds = DEFAULTS.leaseSeconds } = {}) {
    if (!(await provider.isReady())) return null;

    const job = await RenderJob.claimNext({
      runner: 'cloud', stages: stagesFor(provider), workerId, leaseSeconds,
    });
    if (!job) return null;

    return this.runJob(provider, job, { workerId, leaseSeconds });
  },

  /**
   * Keep `concurrency` jobs in flight until the queue runs dry.
   *
   * Each slot claims for itself rather than one claimer handing work out: the
   * claim is a single atomic UPDATE, so N of them racing is exactly what the
   * queue was built for, and a slot that finishes early goes back for more
   * instead of waiting for the slowest of a batch.
   */
  async drain(opts = {}) {
    const provider = opts.provider || this._provider || (this._provider = buildProvider());
    const concurrency = opts.concurrency || DEFAULTS.concurrency;
    let ran = 0;

    const slot = async () => {
      for (;;) {
        if (this._stopping) return;
        const job = await this.tick({ ...opts, provider });
        if (!job) return;
        ran += 1;
        // A guard, not a limit: a handler that somehow re-enqueued its own
        // stage would otherwise spin here forever.
        if (ran > 1000) throw new Error('cloudRunner ran 1000 jobs in one pass — refusing to continue');
      }
    };

    await Promise.all(Array.from({ length: concurrency }, slot));
    return ran;
  },

  /**
   * Whether this process is in a position to render anything.
   *
   * Asked by the API so a screen watching an untouched batch can say WHY
   * nothing has started instead of counting zero at somebody.
   */
  async ready() {
    try {
      const provider = this._provider || (this._provider = buildProvider());
      return await provider.isReady();
    } catch {
      return false;
    }
  },

  start(opts = {}) {
    if (this._timer) return this._timer;
    this._stopping = false;
    const poll = opts.idlePollMs || DEFAULTS.idlePollMs;

    const loop = async () => {
      try {
        await this.drain(opts);
      } catch (err) {
        console.error('[studio/cloudRunner]', err.message);
      }
      if (this._stopping) return;
      this._timer = setTimeout(loop, poll);
      // Do not hold the process open for a poll timer.
      if (this._timer.unref) this._timer.unref();
    };
    loop();
    return this._timer;
  },

  stop() {
    this._stopping = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },
};

module.exports = { CloudRunner, DEFAULTS, stagesFor };
