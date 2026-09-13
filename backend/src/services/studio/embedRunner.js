'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const RenderJob = require('../../models/renderJob');
const JobResult = require('./jobResult');

/**
 * Runs the seed-set check in the API process, when this machine can.
 *
 * ── Why this exists after I said it should be a worker ──────────────────────
 * The question was put as "API or worker", and the honest answer was neither:
 * it is the same shape as the fal renders next door. A fal render moved into
 * this process because a separate process for it was a second thing to keep
 * alive whose failure mode was silence — jobs queue, the screen counts zero,
 * and nothing says the reason is that nobody ran a command. Then the `embed`
 * stage put that exact process back, for one step, and the very first check
 * sat unclaimed for three minutes with a panel explaining it.
 *
 * The concern that made it a worker was real: embedding needs Python and
 * insightface, and an API host cannot be assumed to have them. But "cannot be
 * assumed to" is a question, not an answer, and it has the same answer as
 * FAL_KEY: ASK, and act on what is true here.
 *
 *   • this machine can embed  → it claims the jobs, nothing to start
 *   • it cannot               → it claims nothing, and the job waits for a
 *                               worker on a machine that can
 *
 * So a laptop running the whole Studio just works, a deployed API keeps no
 * Python, and `worker/index.js` is still what serves the second case. Nobody
 * has to know which of those they are in.
 */

const DEFAULTS = {
  workerId:     process.env.STUDIO_EMBED_WORKER_ID || `api-embed-${require('os').hostname()}-${process.pid}`,
  leaseSeconds: 600,   // insightface loads for seconds and then measures dozens of frames
  idlePollMs:   4000,
};

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Can this machine embed faces?
 *
 * Answered by importing the dependencies in a subprocess, not by looking for a
 * binary: `python3` exists nearly everywhere and insightface almost nowhere, so
 * the presence of the interpreter says nothing worth acting on. The model is
 * NOT loaded — that costs seconds and hundreds of megabytes, and this runs on
 * every boot.
 */
function probe({ python = process.env.FACE_EMBED_PYTHON || 'python3',
                 script = path.join(__dirname, '..', '..', '..', 'worker', 'faceEmbed.py') } = {}) {
  return new Promise((resolve) => {
    execFile(python, [script, '--probe'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      // stdout FIRST, even when the exit code is non-zero. The probe exits 1
      // when it cannot import, and it prints the reason — "ModuleNotFoundError:
      // No module named 'insightface'" is something a person can act on, where
      // execFile's own "Command failed: python3 …/faceEmbed.py --probe" is the
      // shape of the failure and none of its substance.
      try {
        const out = JSON.parse(String(stdout).trim().split('\n').pop());
        if (typeof out.ok === 'boolean') {
          return resolve(out.ok ? { ok: true } : { ok: false, error: out.error });
        }
      } catch { /* no answer at all — fall through to why it could not run */ }

      // No JSON means the interpreter itself is missing, or the script is.
      return resolve({
        ok: false,
        error: err
          ? (err.code === 'ENOENT' ? `no such interpreter: ${python}` : err.message)
          : 'the probe did not answer',
      });
    });
  });
}

const EmbedRunner = {
  DEFAULTS,
  probe,

  /** Cached: the answer cannot change without a restart, and the probe spawns. */
  async ready() {
    if (this._ready === undefined) this._ready = await probe();
    return this._ready.ok;
  },

  /** Why not, for a screen that has to explain itself. */
  async reason() {
    await this.ready();
    return this._ready.ok ? null : this._ready.error;
  },

  /**
   * Claim and run at most one check.
   *
   * The embedder is required lazily so that a process which will never embed
   * does not load the module at all, and so a test can stub it.
   */
  async tick({ workerId = DEFAULTS.workerId, leaseSeconds = DEFAULTS.leaseSeconds, embed = null } = {}) {
    if (!(await this.ready())) return null;

    const job = await RenderJob.claimNext({
      runner: 'mac', stages: ['embed'], workerId, leaseSeconds,
    });
    if (!job) return null;

    const run = embed || require('../../../worker/embedSeedSet').runEmbed;
    try {
      const measured = await run(job);
      return await JobResult.settle(job.id, workerId, measured);
    } catch (err) {
      // `permanent` is set by the measurement itself for the one case that will
      // never improve: a frame with no face, or two faces, in the set. Anything
      // else — a cold model download, a dropped fetch — is different next time.
      const permanent = err.permanent === true;
      console.error(`[studio/embedRunner] job ${job.id} failed (${permanent ? 'permanent' : 'will retry'}): ${err.message}`);
      try {
        return await JobResult.settle(job.id, workerId, { ok: false, error: err.message, permanent });
      } catch (settleErr) {
        console.error(`[studio/embedRunner] job ${job.id}: could not record the failure: ${settleErr.message}`);
        return null;
      }
    }
  },

  /**
   * One at a time, deliberately.
   *
   * Unlike a fal render, this is real work on this machine: a model in memory
   * and CPU doing arithmetic. Two at once would load insightface twice and make
   * both slower.
   */
  async drain(opts = {}) {
    let ran = 0;
    for (;;) {
      if (this._stopping) return ran;
      const job = await this.tick(opts);
      if (!job) return ran;
      ran += 1;
      if (ran > 500) throw new Error('embedRunner ran 500 checks in one pass — refusing to continue');
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
        console.error('[studio/embedRunner]', err.message);
      }
      if (this._stopping) return;
      this._timer = setTimeout(loop, poll);
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

module.exports = { EmbedRunner, DEFAULTS, probe };
