'use strict';

/**
 * Node side of the face-embedding extractor.
 *
 * Owns one long-lived `faceEmbed.py` process and speaks line-delimited JSON to
 * it. Long-lived because insightface takes several seconds to load its models,
 * and a four-candidate shoot would otherwise spend more time loading than
 * inferring — and that load time would sit inside a job's lease.
 *
 * Requests are correlated by id and resolved out of a pending map, so a slow
 * image cannot make the next result get handed to the wrong caller. That matters
 * more than it looks: the failure mode of positional matching is a QC pass being
 * attributed to the wrong frame, which is silent and produces exactly the bug
 * the QC gate exists to catch.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class FaceEmbedError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'FaceEmbedError';
    this.permanent = permanent;
  }
}

class FaceEmbedder {
  constructor({
    python = process.env.FACE_EMBED_PYTHON || 'python3',
    script = path.join(__dirname, 'faceEmbed.py'),
    startupTimeoutMs = 120_000,
    requestTimeoutMs = 60_000,
  } = {}) {
    this.python = python;
    this.script = script;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;

    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.dim = null;
  }

  /** Idempotent — several callers may await start() and get the same process. */
  start() {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;

      const timer = setTimeout(() => {
        reject(new FaceEmbedError(`faceEmbed.py did not become ready within ${this.startupTimeoutMs}ms`));
        this.stop();
      }, this.startupTimeoutMs);

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return; // Not our protocol. Ignore rather than crash the worker.
        }

        if (message.ready) {
          clearTimeout(timer);
          this.dim = message.dim;
          resolve(this);
          return;
        }

        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      });

      // Python diagnostics are useful and go to stderr on purpose; surface them
      // rather than swallowing, or an insightface install problem looks like a
      // hang.
      proc.stderr.on('data', (chunk) => process.stderr.write(`[faceEmbed] ${chunk}`));

      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new FaceEmbedError(`faceEmbed.py exited with code ${code}`);
        // Anything still in flight will never be answered. Rejecting is what
        // lets those jobs be retried instead of hanging until the lease expires.
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        this.pending.clear();
        this.ready = null;
        this.proc = null;
        reject(err);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new FaceEmbedError(`Cannot start ${this.python}: ${err.message}`, { permanent: true }));
      });
    });

    return this.ready;
  }

  async isReady() {
    try {
      await this.start();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Measure one image.
   *
   * Returns what was measured, never a verdict — `faceQc.evaluate()` decides
   * whether it passes. Splitting measurement from judgement is what lets the
   * thresholds stay per-(avatar, LoRA, expression, framing) and be recalibrated
   * without touching the extractor.
   */
  async embed(imagePath, { expectAspect = null, aspectTolerance = 0.02 } = {}) {
    await this.start();

    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FaceEmbedError(`Embedding ${imagePath} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.proc.stdin.write(
        `${JSON.stringify({ id, path: imagePath, expect_aspect: expectAspect, aspect_tolerance: aspectTolerance })}\n`
      );
    }).then((result) => {
      if (!result.ok) {
        // A file that cannot be opened or decoded will not decode on retry.
        throw new FaceEmbedError(`Embedding failed for ${imagePath}: ${result.error}`, { permanent: true });
      }
      return result;
    });
  }

  /** Mean of a seed set — the reference vector an avatar's baselines are built from. */
  async embedMany(paths, opts = {}) {
    const out = [];
    for (const p of paths) out.push(await this.embed(p, opts));
    return out;
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
    this.ready = null;
  }
}

module.exports = { FaceEmbedder, FaceEmbedError };
