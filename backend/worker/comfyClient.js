'use strict';

/**
 * Minimal ComfyUI HTTP client.
 *
 * ComfyUI's API is three calls: submit a workflow, poll history until the
 * prompt_id appears, then fetch each output image. There is a websocket too,
 * but polling is fewer moving parts on a laptop that sleeps, and a render takes
 * seconds to minutes — the latency of a 1s poll is noise against that.
 *
 * The distinction this file exists to make is TRANSIENT vs PERMANENT failure.
 * ComfyUI reports a malformed workflow, a missing LoRA or an unknown node as
 * `node_errors` on submit, and those will fail identically on every retry.
 * Retrying them three times just burns the attempt budget and delays the real
 * error reaching the person waiting. A refused connection, by contrast, usually
 * means ComfyUI is still starting.
 */

class ComfyError extends Error {
  constructor(message, { permanent = false, cause = null } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.permanent = permanent;
    this.cause = cause;
  }
}

class ComfyClient {
  constructor({ baseUrl = 'http://127.0.0.1:8188', clientId = 'rstudio', fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = clientId;
    this.fetch = fetchImpl;
  }

  async _json(path, options = {}) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, options);
    } catch (err) {
      // Connection refused: ComfyUI is not up yet. Transient by default —
      // the worker backs off rather than failing every queued job.
      throw new ComfyError(`Cannot reach ComfyUI at ${this.baseUrl}: ${err.message}`, { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 4xx means we sent something ComfyUI will never accept.
      throw new ComfyError(
        `ComfyUI ${options.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`,
        { permanent: res.status >= 400 && res.status < 500 }
      );
    }
    return res.json();
  }

  /** Is ComfyUI up? Used before claiming work, so jobs are not claimed and dropped. */
  async isReady() {
    try {
      await this._json('/system_stats');
      return true;
    } catch {
      return false;
    }
  }

  /** Submit an API-format workflow. Returns the prompt_id. */
  async submit(workflow) {
    const body = await this._json('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });

    // ComfyUI answers 200 with node_errors rather than a 4xx for a bad graph,
    // so the happy-path status code is not enough to trust.
    if (body.node_errors && Object.keys(body.node_errors).length) {
      throw new ComfyError(
        `Workflow rejected: ${JSON.stringify(body.node_errors).slice(0, 600)}`,
        { permanent: true }
      );
    }
    if (!body.prompt_id) {
      throw new ComfyError(`No prompt_id in response: ${JSON.stringify(body).slice(0, 300)}`, { permanent: true });
    }
    return body.prompt_id;
  }

  /**
   * Poll until the prompt finishes.
   *
   * `onProgress` fires each tick so the caller can heartbeat its lease — without
   * that, a render longer than the lease gets reaped out from under a worker
   * that is doing nothing wrong.
   */
  async waitForResult(promptId, { timeoutMs = 900_000, pollMs = 1000, onProgress = null } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const history = await this._json(`/history/${promptId}`);
      const entry = history[promptId];

      if (entry) {
        const status = entry.status || {};
        if (status.status_str === 'error' || status.completed === false) {
          const detail = JSON.stringify(status.messages || status).slice(0, 600);
          throw new ComfyError(`Execution failed: ${detail}`, { permanent: true });
        }
        if (entry.outputs && Object.keys(entry.outputs).length) {
          return this._collectImages(entry.outputs);
        }
      }

      if (onProgress) await onProgress();
      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new ComfyError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${promptId}`);
  }

  _collectImages(outputs) {
    const images = [];
    for (const nodeOutput of Object.values(outputs)) {
      for (const img of nodeOutput.images || []) {
        images.push({
          filename: img.filename,
          subfolder: img.subfolder || '',
          type: img.type || 'output',
        });
      }
    }
    if (!images.length) {
      throw new ComfyError('Prompt completed but produced no images', { permanent: true });
    }
    return images;
  }

  /** Download one output as a Buffer. */
  async fetchImage({ filename, subfolder = '', type = 'output' }) {
    const qs = new URLSearchParams({ filename, subfolder, type });
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/view?${qs}`);
    } catch (err) {
      throw new ComfyError(`Cannot download ${filename}: ${err.message}`, { cause: err });
    }
    if (!res.ok) {
      throw new ComfyError(`Download ${filename} → ${res.status}`, { permanent: res.status === 404 });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Free VRAM/unified memory between model classes. See the 36 GB note in index.js. */
  async freeMemory({ unloadModels = true, freeMemory = true } = {}) {
    try {
      await this.fetch(`${this.baseUrl}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
      });
    } catch {
      // Best effort. An older ComfyUI without /free is not a reason to fail a job.
    }
  }
}

module.exports = { ComfyClient, ComfyError };
