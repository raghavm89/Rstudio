"use strict";

const os = require("os");
const RenderJob = require("../../models/renderJob");
const JobResult = require("./jobResult");
const pool = require("../../config/db");
const { probe } = require("./embedRunner");
const { runQc } = require("./qcStage");

/**
 * Runs the `qc` stage in this process, when this machine can measure faces.
 *
 * The same shape and the same reasoning as EmbedRunner: QC needs insightface, an
 * API host cannot be assumed to have it, so ASK and act on what is true here — a
 * laptop running the whole Studio claims QC jobs, a deployed API keeps no Python
 * and they wait for a worker that has it. It claims both the 'cloud' and 'mac'
 * runner labels, because a still (and so its QC) is 'cloud' by default but 'mac'
 * for local R&D, and QC follows its still.
 */

const DEFAULTS = {
  workerId: process.env.STUDIO_QC_WORKER_ID || `api-qc-${os.hostname()}-${process.pid}`,
  leaseSeconds: 600,
  idlePollMs: 4000,
  runners: ["cloud", "mac"],
};

const QcRunner = {
  DEFAULTS,
  probe,

  async ready() {
    if (this._ready === undefined) this._ready = await probe();
    return this._ready.ok;
  },
  async reason() {
    await this.ready();
    return this._ready.ok ? null : this._ready.error;
  },

  /**
   * One long-lived embedder PER subject_type, created lazily.
   *
   * A person is measured by insightface, a character by CLIP (embedderFactory
   * decides which). Both cost seconds to load, so each is cached and reused —
   * but they are separate processes with separate models, so a shoot that mixes
   * people and characters keeps one of each rather than reloading on every job.
   */
  _embedder(subjectType) {
    if (!this._embs) this._embs = new Map();
    const { makeEmbedder, subjectKey } = require("../../../worker/embedderFactory");
    const key = subjectKey(subjectType);
    if (!this._embs.has(key)) this._embs.set(key, makeEmbedder(key));
    return this._embs.get(key);
  },

  async tick({ workerId = DEFAULTS.workerId, leaseSeconds = DEFAULTS.leaseSeconds, runners = DEFAULTS.runners, embedder = null } = {}) {
    if (!(await this.ready())) return null;

    let job = null;
    for (const runner of runners) {
      job = await RenderJob.claimNext({ runner, stages: ["qc"], workerId, leaseSeconds });
      if (job) break;
    }
    if (!job) return null;

    const emb = embedder || this._embedder(job.payload?.subject_type);
    try {
      const report = await runQc(job, { embedder: emb });
      return await JobResult.settle(job.id, workerId, report);
    } catch (err) {
      const permanent = err.permanent === true;
      const _detail = (err.qcResult && err.qcResult.candidates || [])
        .map((c) => `${c.reason || "ok"}${c.similarity != null ? ` @${c.similarity}` : ""}`).join(", ");
      console.error(`[studio/qcRunner] job ${job.id} failed (${permanent ? "permanent" : "will retry"}): ${err.message}${_detail ? ` — candidates: ${_detail}` : ""}`);
      const failed = await this._settleFail(job.id, workerId, err, permanent);

      // A shot with no acceptable frame must not have its motion animate a
      // rejected face — block whatever depends on this QC.
      if (permanent && failed && failed.status === "failed") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await RenderJob.blockDependentsTx(client, job.id);
          await client.query("COMMIT");
        } catch (blockErr) {
          await client.query("ROLLBACK").catch(() => {});
          console.error(`[studio/qcRunner] job ${job.id}: could not block dependents: ${blockErr.message}`);
        } finally {
          client.release();
        }
      }
      return failed;
    }
  },

  async _settleFail(jobId, workerId, err, permanent) {
    try {
      return await JobResult.settle(jobId, workerId, { ok: false, error: err.message, permanent });
    } catch (e) {
      console.error(`[studio/qcRunner] job ${jobId}: could not record the failure: ${e.message}`);
      return null;
    }
  },

  async drain(opts = {}) {
    let ran = 0;
    for (;;) {
      if (this._stopping) return ran;
      const job = await this.tick(opts);
      if (!job) return ran;
      ran += 1;
      if (ran > 500) throw new Error("qcRunner ran 500 checks in one pass — refusing to continue");
    }
  },

  start(opts = {}) {
    if (this._timer) return this._timer;
    this._stopping = false;
    const poll = opts.idlePollMs || DEFAULTS.idlePollMs;
    const loop = async () => {
      try { await this.drain(opts); }
      catch (err) { console.error("[studio/qcRunner]", err.message); }
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
    if (this._embs) {
      for (const [, emb] of this._embs) if (emb && emb.stop) emb.stop();
      this._embs = null;
    }
  },
};

module.exports = { QcRunner, DEFAULTS };
