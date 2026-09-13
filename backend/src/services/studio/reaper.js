'use strict';

const RenderJob = require('../../models/renderJob');

/**
 * Returns abandoned work to the queue.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `RenderJob.reapExpiredLeases` has been correct since the day it was written,
 * and **nothing has ever called it**. The only caller was an HTTP endpoint
 * (`POST /api/studio/jobs/reap`, commented "safe to call on a timer") that no
 * timer anywhere invoked.
 *
 * The whole lease design rests on this. `renderJob.js` says so at the top:
 * "if a worker dies mid-job the lease expires and reapExpiredLeases returns the
 * work to the queue. Without the lease, a laptop that closes mid-render strands
 * the job forever in `claimed`." Every layer was built for a reaper — claiming
 * takes a lease, long renders heartbeat to extend it, `LEASE_LOST` is a code a
 * worker knows how to handle — and then nothing expired anything, so all of it
 * was ceremony.
 *
 * What that looked like: a training run held by the API process, the API
 * restarted to pick up a migration, and the job left `running` with its lease
 * frozen at the moment the process died. The screen counted upward past the
 * twenty minutes it had promised, forever, because from the outside a job
 * nobody is working on is indistinguishable from one that is — the row says
 * `running` either way.
 *
 * ── Why every process runs it ───────────────────────────────────────────────
 * It is one idempotent UPDATE over an indexed predicate. Two API instances
 * running it concurrently reap the same rows once between them, because the
 * statement's own WHERE clause is the guard. Electing a leader to do this would
 * be more moving parts than the thing being protected.
 */

const DEFAULTS = {
  // A minute. The shortest lease anyone takes is 30s and the usual is 300s, so
  // this finds a dead worker within a lease of it going quiet — long before a
  // person watching a progress bar gives up, and rarely enough to be free.
  everyMs: Math.min(Math.max(parseInt(process.env.STUDIO_REAP_MS, 10) || 60_000, 5_000), 3_600_000),
};

const Reaper = {
  DEFAULTS,

  /** One pass. Returns what it returned to the queue. */
  async tick() {
    const reaped = await RenderJob.reapExpiredLeases();
    for (const job of reaped) {
      // Worth a line each: a requeue is invisible otherwise, and "why did this
      // render twice" is a question somebody eventually asks.
      console.warn(`[studio/reaper] job ${job.id} lease expired → ${job.status} (attempt ${job.attempts})`);
    }
    return reaped;
  },

  start(opts = {}) {
    if (this._timer) return this._timer;
    this._stopping = false;
    const every = opts.everyMs || DEFAULTS.everyMs;

    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        // A failed pass is a pass. The next one does the same work, and a
        // reaper that dies on one bad query leaves every future job stranded.
        console.error('[studio/reaper]', err.message);
      }
      if (this._stopping) return;
      this._timer = setTimeout(loop, every);
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

module.exports = { Reaper, DEFAULTS };
