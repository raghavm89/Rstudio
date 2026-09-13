'use strict';

const pool        = require('../../config/db');
const RenderJob   = require('../../models/renderJob');
const PromptStage = require('./promptStage');
const AssembleStage = require('./assembleStage');
const CopyStage = require('./copyStage');
const VoiceStage = require('./voiceStage');

/**
 * Runs the `server` stages in the API process.
 *
 * Three of the DAG's stages need the database and nothing else — `prompt`
 * assembles the generation blocks, `assemble` stitches clips, `copy` writes the
 * caption. Handing those to a render worker would mean giving a shared secret
 * that lives on a laptop the ability to read tenant content, and the worker
 * grant is deliberately narrow: a leaked worker token should cost renders, not
 * data.
 *
 * So they run here, claimed through the same queue with the same lease
 * semantics as everything else. Same claiming path means the same guarantees —
 * two API instances cannot both take one job, and a crashed instance's work is
 * reaped rather than lost.
 *
 * Started from app.js:
 *
 *   const { ServerRunner } = require('./services/studio/serverRunner');
 *   if (process.env.STUDIO_SERVER_RUNNER !== 'off') ServerRunner.start();
 */

const HANDLERS = {
  prompt:   (job) => PromptStage.execute(job),
  voice:    (job) => VoiceStage.execute(job),
  assemble: (job) => AssembleStage.execute(job),
  copy:     (job) => CopyStage.execute(job),
};

const DEFAULTS = {
  workerId: process.env.STUDIO_SERVER_WORKER_ID || `api-${require('os').hostname()}-${process.pid}`,
  leaseSeconds: 120,
  idlePollMs: 2000,
};

const ServerRunner = {
  HANDLERS,

  /**
   * Claim and run at most one job. Returns the job, or null when idle.
   *
   * Exposed separately from the loop so tests drive it a tick at a time, and so a
   * deployment that would rather run this from a cron than a timer can.
   */
  async tick({ workerId = DEFAULTS.workerId, leaseSeconds = DEFAULTS.leaseSeconds } = {}) {
    const stages = Object.keys(HANDLERS);
    const job = await RenderJob.claimNext({ runner: 'server', stages, workerId, leaseSeconds });
    if (!job) return null;

    try {
      const result = await HANDLERS[job.stage](job);
      return await RenderJob.complete(job.id, workerId, { result });
    } catch (err) {
      // Server stages are deterministic: given the same rows they fail the same
      // way every time. So an error carrying an explicit `permanent` flag is
      // trusted, and anything else is treated as transient — a dropped
      // connection should not permanently kill a shoot.
      const permanent = err.permanent === true;
      const failed = await RenderJob.fail(job.id, workerId, String(err.message), { permanent });

      // A dead prompt stage means every still, qc, motion and assemble job below
      // it is waiting on something that will never complete. Block them rather
      // than leaving nine jobs queued forever against a parent that failed.
      if (failed && failed.status === 'failed') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await RenderJob.blockDependentsTx(client, job.id);
          await client.query('COMMIT');
        } catch (blockErr) {
          await client.query('ROLLBACK');
          throw blockErr;
        } finally {
          client.release();
        }
      }
      return failed;
    }
  },

  /** Drain the queue until it is empty. Returns how many ran. */
  async drain(opts = {}) {
    let n = 0;
    for (;;) {
      const job = await this.tick(opts);
      if (!job) return n;
      n += 1;
      // A guard, not a limit: a handler that somehow re-enqueues its own stage
      // would otherwise spin here forever holding a connection.
      if (n > 1000) throw new Error('serverRunner drained 1000 jobs in one pass — refusing to continue');
    }
  },

  start(opts = {}) {
    if (this._timer) return this._timer;
    const poll = opts.idlePollMs || DEFAULTS.idlePollMs;
    const loop = async () => {
      try {
        await this.drain(opts);
      } catch (err) {
        console.error('[studio/serverRunner]', err.message);
      }
      this._timer = setTimeout(loop, poll);
      // Do not hold the process open for a poll timer.
      if (this._timer.unref) this._timer.unref();
    };
    loop();
    return this._timer;
  },

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },
};

module.exports = { ServerRunner, DEFAULTS };
