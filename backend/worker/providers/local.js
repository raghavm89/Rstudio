'use strict';

/**
 * Local ComfyUI provider.
 *
 * A thin adapter that puts ComfyClient behind the same interface as the fal
 * provider, so `worker/index.js` never branches on which one it is holding.
 *
 * This path is for R&D that never leaves the machine — persona development, seed
 * culling, expression-baseline calibration, prompt sweeps. FLUX.1-dev weights are
 * non-commercial, so anything that will actually be published must go through
 * fal instead. `runnerPolicy.js` on the server side is what enforces that; this
 * file just refuses to pretend the distinction does not exist, which is why its
 * cost is reported as zero and its provider name says `local_mac` rather than
 * something that reads like a billable vendor.
 */

const { ComfyClient, ComfyError } = require('../comfyClient');

class LocalProvider {
  constructor({ baseUrl, clientId, client = null } = {}) {
    this.name = 'local_mac';
    this.client = client || new ComfyClient({ baseUrl, clientId });
  }

  isReady() {
    return this.client.isReady();
  }

  supports(stage) {
    return stage === 'still' || stage === 'qc';
  }

  async run(job, { onProgress } = {}) {
    const workflow = job.payload?.workflow;
    if (!workflow || typeof workflow !== 'object') {
      throw new ComfyError('Job payload has no workflow object', { permanent: true });
    }

    const promptId = await this.client.submit(workflow);
    const images = await this.client.waitForResult(promptId, { onProgress });

    return {
      artifacts: images.map((image) => ({
        filename: image.filename,
        contentType: 'image/png',
        url: null,
        fetch: () => this.client.fetchImage(image),
      })),
      meta: {
        provider: this.name,
        request_id: promptId,
        megapixels: Number(job.payload?.megapixels || 0),
        seconds_generated: 0,
        // Local generation has no provider bill. Recording zero rather than
        // omitting it keeps the cost query honest when local and cloud work sit
        // side by side in the same table.
        cost_cents: 0,
      },
    };
  }

  /** Release the model between jobs. On 36 GB the alternative to unloading is swapping. */
  async afterJob() {
    await this.client.freeMemory();
  }
}

module.exports = { LocalProvider };
