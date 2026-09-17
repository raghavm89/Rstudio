'use strict';

/**
 * Node side of the whole-image (CLIP) embedder — the CHARACTER counterpart to
 * faceEmbed.js.
 *
 * Same shape as FaceEmbedder, deliberately: one long-lived Python process,
 * line-delimited JSON, requests correlated by id out of a pending map so a slow
 * image can never hand its result to the wrong caller. The only differences are
 * the script it drives (clipEmbed.py) and that a CLIP result has no `faces`
 * count — a whole-image embedding always exists, so there is no "no face" case
 * to report. Identity is the cosine alone; faceQc's character branch skips the
 * face-only structural rejects.
 *
 * Kept as its own class rather than parameterising FaceEmbedder because the two
 * point at different models with different load costs and different env knobs,
 * and a shared class that switched scripts by a flag would be one object whose
 * behaviour depended on how it was constructed — exactly the ambiguity the
 * embedder factory exists to make explicit instead.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class ClipEmbedError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'ClipEmbedError';
    this.permanent = permanent;
  }
}

class ClipEmbedder {
  constructor({
    // Falls back to the face extractor's interpreter: on the Mac both models
    // live in the same torch env, so one CLIP_EMBED_PYTHON override is rarely
    // needed and FACE_EMBED_PYTHON is the sensible default.
    python = process.env.CLIP_EMBED_PYTHON || process.env.FACE_EMBED_PYTHON || 'python3',
    script = path.join(__dirname, 'clipEmbed.py'),
    startupTimeoutMs = 180_000,   // CLIP pulls ~600MB the first time it runs
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
        reject(new ClipEmbedError(`clipEmbed.py did not become ready within ${this.startupTimeoutMs}ms`));
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

      proc.stderr.on('data', (chunk) => process.stderr.write(`[clipEmbed] ${chunk}`));

      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new ClipEmbedError(`clipEmbed.py exited with code ${code}`);
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
        reject(new ClipEmbedError(`Cannot start ${this.python}: ${err.message}`, { permanent: true }));
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
   * Measure one image. Returns what was measured, never a verdict.
   *
   * The result shape matches faceEmbed's where the two overlap (`ok`,
   * `embedding`, `width`, `height`, `aspect`, `aspect_ok`) so qcStage reads them
   * the same way; there is simply no `faces`/`significant_faces` — for a
   * character those are meaningless, and qcStage's `?? 0` fallback lands on a
   * count the character branch of faceQc ignores.
   */
  async embed(imagePath, { expectAspect = null, aspectTolerance = 0.02 } = {}) {
    await this.start();

    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClipEmbedError(`Embedding ${imagePath} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.proc.stdin.write(
        `${JSON.stringify({ id, path: imagePath, expect_aspect: expectAspect, aspect_tolerance: aspectTolerance })}\n`
      );
    }).then((result) => {
      if (!result.ok) {
        throw new ClipEmbedError(`Embedding failed for ${imagePath}: ${result.error}`, { permanent: true });
      }
      return result;
    });
  }

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

module.exports = { ClipEmbedder, ClipEmbedError };
