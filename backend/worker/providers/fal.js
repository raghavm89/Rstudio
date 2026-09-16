'use strict';

/**
 * fal provider — the primary generation path.
 *
 * This was designed as the fallback and is now the default, for a licence
 * reason rather than a technical one: FLUX.1-dev weights are non-commercial,
 * and a monetised avatar channel is commercial use of the outputs. fal's hosted
 * endpoints carry commercial rights through their agreement with BFL, so
 * anything that will actually be published goes through here. Local ComfyUI
 * stays for R&D that never leaves the machine.
 *
 * fal's queue API is three calls, same shape as ComfyUI:
 *   POST {queue}/{model}                        → { request_id, status_url, response_url }
 *   GET  {status_url}                           → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  {response_url}                         → the payload
 *
 * The distinction this file exists to make is the same one comfyClient.js makes:
 * TRANSIENT vs PERMANENT. A 429 is a queue that is busy and will clear. A 422 is
 * an input fal will reject identically on every retry, and retrying it three
 * times only delays the real error reaching the person waiting — while still
 * burning the attempt budget.
 *
 * One classification here is easy to get wrong: a content-policy rejection comes
 * back on a SUCCESSFUL request, as `has_nsfw_concepts: [true]` alongside a normal
 * 200. Treating that as success would hand the pipeline a blank or blocked image
 * and let QC blame the LoRA.
 */

const PROVIDER = 'fal';

const DEFAULT_QUEUE = 'https://queue.fal.run';
const DEFAULT_STORAGE = 'https://rest.alpha.fal.ai/storage';

/** fal's current CDN generation. The storage endpoint 403s without it. */
const STORAGE_TYPE = process.env.FAL_STORAGE_TYPE || 'fal-cdn-v3';

/** Above this fal wants a multipart upload, which this client does not implement. */
const MULTIPART_THRESHOLD_BYTES = 90 * 1024 * 1024;

/**
 * Model ids are env-overridable because fal renames and versions endpoints on
 * their schedule, not ours, and a rename should be a deploy variable rather than
 * a code change.
 */
const ENDPOINTS = {
  still:      process.env.FAL_STILL_MODEL  || 'fal-ai/flux-lora',
  // The same model as `still`, and a separate key on purpose.
  //
  // Not because the render differs — it is the same endpoint with the same
  // adapter — but because `supports()` reads these keys to decide which stages
  // a runner may claim, and calibration is a stage of its own for a BILLING
  // reason: `still` is metered against the month's shooting budget and
  // calibration must not be. A stage that bills differently needs its own key
  // here or the in-process runner will never pick it up.
  calib_still: process.env.FAL_CALIB_MODEL || process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora',
  // Base Flux, no LoRA adapter — there is no LoRA yet, which is the entire
  // point of the step this serves. A different endpoint from `still` because
  // flux-lora requires an adapter and refuses without one.
  seed_still: process.env.FAL_BASE_MODEL   || 'fal-ai/flux/dev',
  // Seedance 2.0 added a partner face/likeness filter that refuses photorealistic
  // human faces (content_policy_violation / partner_validation_failed) - a
  // dealbreaker for a realistic human avatar. Seedance v1 pro has no such filter
  // and is the model that animated Aanya's hero clip. Override with FAL_MOTION_MODEL.
  motion:     process.env.FAL_MOTION_MODEL || 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  lora_train: process.env.FAL_LORA_TRAINER || 'fal-ai/flux-lora-fast-training',
};

/**
 * The identity-preserving endpoint, kept OUT of ENDPOINTS on purpose.
 *
 * ENDPOINTS is keyed by STAGE, and `supports()` reads it to answer "may this
 * runner claim that stage" — so a key here would invent a `seed_anchored` stage
 * that the API has never heard of, and the in-process runner would claim jobs
 * that cannot exist. Anchored generation is not a different stage; it is the
 * same `seed_still` stage rendered a different way, decided by whether the job
 * carries a reference face.
 */
const ANCHORED_MODEL = process.env.FAL_ANCHORED_MODEL || 'fal-ai/flux-pulid';

/** Storage serves by extension, so the name has to agree with the bytes. */
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Prices in cents, fractional on purpose.
 *
 * A 1 MP still is 3.5 cents. Rounding that to an integer is a 14% error on every
 * single image, and `cost_cents` exists specifically so the self-hosting
 * decision is a query rather than a guess — a 14% bias would point that query
 * the wrong way. Migration 032 widens the column to NUMERIC(12,4) so these
 * survive the round trip.
 */
const PRICING = {
  stillPerMegapixelCents: Number(process.env.FAL_PRICE_STILL_MP_CENTS ?? 3.5),
  /**
   * The identity-preserving endpoint bills separately, and this default is a
   * PLACEHOLDER equal to the plain still rate.
   *
   * It is set that way because inventing a number would be worse: `cost_cents`
   * exists so the self-hosting decision is a query rather than a guess, and a
   * made-up rate poisons that query in the direction nobody notices —
   * undercharging. Confirm the real rate on fal's pricing page and set
   * FAL_PRICE_ANCHORED_MP_CENTS. Until then this reports the floor, and the
   * floor is knowingly the floor.
   */
  anchoredPerMegapixelCents: Number(
    process.env.FAL_PRICE_ANCHORED_MP_CENTS ?? process.env.FAL_PRICE_STILL_MP_CENTS ?? 3.5),
  /**
   * Video (Seedance v1 Pro i2v) is billed by RESOLUTION, because fal prices it
   * by TOKENS rather than a flat per-second rate:
   *
   *     tokens(video) = (height x width x fps x duration) / 1024
   *     cost          = tokens x $2.5 / 1,000,000     (v1 Pro rate, fal, Sep 2026)
   *
   * fal does not take an fps from us; the model outputs ~24 fps, which is what
   * reproduces fal's published headline of ~$0.62 for a 1080p 5s clip. At 24 fps
   * and $2.5/M tokens the per-second output cost works out to:
   *
   *     480p  (854x480)   -> 2.40 c/s
   *     720p  (1280x720)  -> 5.40 c/s
   *     1080p (1920x1080) -> 12.15 c/s
   *
   * (Orientation does not matter: a 9:16 reel has the same pixel count as 16:9.)
   *
   * These REPLACE the previous 7.21 / 15.47 defaults, which were Seedance 2.0
   * *Mini* rates mislabelled onto the v1 Pro endpoint this worker actually calls
   * (ENDPOINTS.motion) — they overstated motion spend ~2.85x on the one column
   * the self-hosting decision reads. They now match studio/hero-assets.js, which
   * carried the correct token-derived numbers all along. An unrecognised
   * resolution bills at the HIGHEST known rate (see runMotion): guessing low
   * quietly under-reports the one number that must never flatter itself. Every
   * rate is env-overridable if fal's fps or per-token price moves.
   */
  motionPerSecondCentsByResolution: {
    '480p':  Number(process.env.FAL_PRICE_MOTION_480_SEC_CENTS  ?? 2.4),
    '720p':  Number(process.env.FAL_PRICE_MOTION_720_SEC_CENTS  ?? 5.4),
    '1080p': Number(process.env.FAL_PRICE_MOTION_1080_SEC_CENTS ?? 12.15),
  },
  loraTrainCents:         Number(process.env.FAL_PRICE_LORA_TRAIN_CENTS ?? 200),
};

class FalError extends Error {
  constructor(message, { permanent = false, cause = null, code = null } = {}) {
    super(message);
    this.name = 'FalError';
    this.permanent = permanent;
    this.cause = cause;
    this.code = code;
  }
}

/**
 * Which HTTP statuses are worth trying again.
 *
 * 401/403 is a bad or revoked key. It will not fix itself on retry, and marking
 * it transient would leave every job in the queue silently cycling until the
 * attempt budget ran out — which reads to the operator as "generation is slow"
 * rather than "your key is wrong".
 */
function classifyStatus(status) {
  if (status === 429) return { permanent: false, code: 'RATE_LIMITED' };
  if (status === 408) return { permanent: false, code: 'UPSTREAM_TIMEOUT' };
  if (status === 401 || status === 403) return { permanent: true, code: 'BAD_CREDENTIALS' };
  if (status === 422) return { permanent: true, code: 'INVALID_INPUT' };
  if (status === 404) return { permanent: true, code: 'UNKNOWN_MODEL' };
  if (status >= 400 && status < 500) return { permanent: true, code: 'REJECTED' };
  return { permanent: false, code: 'UPSTREAM_ERROR' };
}

class FalProvider {
  constructor({
    apiKey = process.env.FAL_KEY || '',
    queueUrl = process.env.FAL_QUEUE_URL || DEFAULT_QUEUE,
    storageUrl = process.env.FAL_STORAGE_URL || DEFAULT_STORAGE,
    fetchImpl = globalThis.fetch,
    endpoints = ENDPOINTS,
    pricing = PRICING,
  } = {}) {
    this.name = PROVIDER;
    this.apiKey = apiKey;
    this.queueUrl = queueUrl.replace(/\/+$/, '');
    this.storageUrl = storageUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.endpoints = { ...ENDPOINTS, ...endpoints };
    this.anchoredModel = ANCHORED_MODEL;
    this.pricing = { ...PRICING, ...pricing };
  }

  /**
   * Unlike ComfyUI there is nothing to boot, so readiness is only "do we hold a
   * key". Returning false rather than throwing keeps the worker loop identical
   * across providers: it waits instead of claiming work it cannot start.
   */
  async isReady() {
    return Boolean(this.apiKey);
  }

  supports(stage) {
    return Object.prototype.hasOwnProperty.call(this.endpoints, stage);
  }

  _headers() {
    return {
      'Authorization': `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async _request(url, options = {}) {
    let res;
    try {
      res = await this.fetch(url, options);
    } catch (err) {
      // Network-level: DNS, TLS, socket. fal is up far more often than not, so
      // the useful default is "try again".
      throw new FalError(`Cannot reach fal at ${url}: ${err.message}`, { cause: err, code: 'UNREACHABLE' });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const { permanent, code } = classifyStatus(res.status);
      throw new FalError(
        `fal ${options.method || 'GET'} ${url} → ${res.status}: ${body.slice(0, 400)}`,
        { permanent, code }
      );
    }

    return res.json();
  }

  /** Submit to the queue. Returns the handle we poll. */
  async submit(stage, input, { model = this.endpoints[stage] } = {}) {
    if (!model) {
      throw new FalError(`No fal endpoint configured for stage "${stage}"`, { permanent: true, code: 'NO_ENDPOINT' });
    }
    if (!this.apiKey) {
      throw new FalError('FAL_KEY is not set', { permanent: true, code: 'BAD_CREDENTIALS' });
    }

    const body = await this._request(`${this.queueUrl}/${model}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(input),
    });

    if (!body.request_id) {
      throw new FalError(`No request_id in submit response: ${JSON.stringify(body).slice(0, 300)}`, { permanent: true });
    }

    // Prefer the URLs fal hands back over ones we construct — they encode the
    // routing for models served off the default queue host, and a constructed
    // URL for those 404s in a way that looks like an unknown model.
    return {
      requestId: body.request_id,
      statusUrl: body.status_url || `${this.queueUrl}/${model}/requests/${body.request_id}/status`,
      responseUrl: body.response_url || `${this.queueUrl}/${model}/requests/${body.request_id}`,
    };
  }

  /**
   * Poll until the request leaves the queue.
   *
   * `onProgress` fires every tick so the caller can heartbeat its lease. Without
   * it a render longer than the lease gets reaped out from under a worker that is
   * doing nothing wrong — the same trap as the ComfyUI path, and the reason both
   * clients take the same callback.
   */
  async waitForResult(handle, { timeoutMs = 900_000, pollMs = 1500, onProgress = null } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this._request(handle.statusUrl, { headers: this._headers() });

      if (status.status === 'COMPLETED') {
        return this._request(handle.responseUrl, { headers: this._headers() });
      }
      if (status.status === 'ERROR' || status.status === 'FAILED') {
        const detail = JSON.stringify(status.error || status).slice(0, 600);
        throw new FalError(`fal execution failed: ${detail}`, { permanent: true, code: 'EXECUTION_FAILED' });
      }

      if (onProgress) await onProgress(status);
      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new FalError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${handle.requestId}`,
      { code: 'TIMEOUT' }
    );
  }

  // ── Stages ──────────────────────────────────────────────────────────────────

  /**
   * The generation block is assembled server-side by buildWorkflow and carried on
   * the job payload, so this provider never composes a prompt. That is the same
   * guarantee the ComfyUI path gives: the identity block reaches the model
   * byte-identical regardless of which provider renders it.
   */
  _stillInput(gen) {
    if (!gen || !gen.prompt) {
      throw new FalError('Job payload has no generation.prompt', { permanent: true, code: 'NO_PROMPT' });
    }
    if (!gen.lora || !gen.lora.path) {
      throw new FalError('Job payload has no generation.lora.path', { permanent: true, code: 'NO_LORA' });
    }

    return {
      prompt: gen.prompt,
      image_size: { width: gen.width, height: gen.height },
      num_inference_steps: gen.steps ?? 24,
      guidance_scale: gen.guidance ?? 3.5,
      num_images: gen.candidates ?? 1,
      seed: gen.seed,
      loras: [{ path: gen.lora.path, scale: gen.lora.scale ?? 0.95 }],
      output_format: 'png',
      // Left on deliberately. A fashion persona will occasionally trip it, and
      // that surfaces below as a permanent failure with a clear message rather
      // than a blank frame QC would blame on the LoRA.
      enable_safety_checker: gen.safety !== false,
    };
  }

  /**
   * A still from a trained LoRA.
   *
   * Serves `still` and `calib_still`, which are the same render against
   * different meters. The endpoint is resolved from the JOB's stage rather than
   * hard-coded to `still`, so the two can be pointed at different models by env
   * without a second method — and so `_imagesToResult` is told the model that
   * actually ran, which is what it prices from.
   */
  async runStill(job, { onProgress } = {}) {
    const gen = job.payload?.generation;
    const input = this._stillInput(gen);

    const stage = this.endpoints[job.stage] ? job.stage : 'still';
    const handle = await this.submit(stage, input);
    const out = await this.waitForResult(handle, { onProgress });

    return this._imagesToResult({ gen, input, out, model: this.endpoints[stage], requestId: handle.requestId });
  }

  /**
   * Candidate frames for a seed set — the one render that runs before a LoRA.
   *
   * A separate method rather than a flag on `runStill`, because `_stillInput`
   * refuses a job with no `generation.lora.path` and that refusal is load
   * bearing everywhere else: for any other still, a missing LoRA means the
   * model renders a stranger and QC compares it against a baseline it cannot
   * meet. Relaxing the guard to serve this one case would remove it for all of
   * them.
   *
   * Everything after submission is identical, so it is shared.
   */
  async runSeedStill(job, { onProgress } = {}) {
    const gen = job.payload?.generation;
    if (!gen || !gen.prompt) {
      throw new FalError('Seed job payload has no generation.prompt', { permanent: true, code: 'NO_PROMPT' });
    }
    // Asserted rather than assumed. A LoRA path arriving on a seed job means a
    // payload was built by the wrong code path, and rendering it anyway would
    // put a trained face into the set that is supposed to define that face.
    if (gen.lora) {
      throw new FalError('A seed candidate must not carry a LoRA — it is what trains one',
        { permanent: true, code: 'SEED_WITH_LORA' });
    }

    /**
     * Anchored, or an independent draw?
     *
     * Without a reference this is base Flux from the identity block, which is
     * what an ANCHOR frame is: one of a handful of independent draws offered as
     * a choice. With a reference it is the identity-preserving endpoint
     * conditioned on the frame the customer picked, which is what every frame
     * of the POOL is.
     *
     * The difference is the job's payload, not the stage. Both are `seed_still`
     * — same queue, same lease, same meter, same refund path — because they are
     * the same act billed the same way, and a second stage would have to be
     * registered in five places to say so.
     */
    if (gen.reference_image_url) return this._runAnchored(gen, { onProgress });

    const input = {
      prompt: gen.prompt,
      image_size: { width: gen.width, height: gen.height },
      num_inference_steps: gen.steps ?? 24,
      guidance_scale: gen.guidance ?? 3.5,
      num_images: 1,
      seed: gen.seed,
      output_format: 'png',
      enable_safety_checker: gen.safety !== false,
    };

    const handle = await this.submit('seed_still', input);
    const out = await this.waitForResult(handle, { onProgress });
    return this._imagesToResult({ gen, input, out, model: this.endpoints.seed_still, requestId: handle.requestId });
  }

  /**
   * A pool frame, generated from the chosen anchor face.
   *
   * Text describes a TYPE of person, not a person, so twenty-four independent
   * draws are twenty-four people who match the description. Measured on the one
   * persona culled by hand, 209 frames yielded 16 keepers — and the export gate
   * needs twelve. Conditioning on a face we already generated makes the draws
   * dependent, which is the whole point.
   */
  async _runAnchored(gen, { onProgress } = {}) {
    // On local-disk storage this pushes the anchor through fal's own storage
    // first; on a public bucket it is a no-op. fal FETCHES the reference — it
    // is not uploaded with the request — so an unreachable URL fails as an
    // unhelpful upstream error rather than "your storage is not public".
    const referenceUrl = await this.ensureFetchable(gen.reference_image_url, {
      publiclyFetchable: gen.publicly_fetchable !== false,
      filename: 'anchor.png',
      contentType: 'image/png',
    });

    const input = {
      prompt: gen.prompt,
      reference_image_url: referenceUrl,
      image_size: { width: gen.width, height: gen.height },
      num_inference_steps: gen.steps ?? 20,
      guidance_scale: gen.guidance ?? 4,
      // How hard the face is held. 1 is the endpoint's default; below it the
      // pool drifts back toward a casting call, and far above it every frame
      // becomes the anchor again in a different shirt — which trains a LoRA
      // that only knows one pose.
      id_weight: gen.id_weight ?? 1,
      // 128 is the default and our prompts are longer than that. The identity
      // block alone runs to 45 words before the grid appends angle, framing,
      // light, wardrobe, location and expression — and those tail fragments are
      // exactly the axes the export gate checks for. A truncated prompt drops
      // them silently and the coverage strip can never be satisfied.
      max_sequence_length: '512',
      seed: gen.seed,
      enable_safety_checker: gen.safety !== false,
    };

    const handle = await this.submit('seed_still', input, { model: this.anchoredModel });
    const out = await this.waitForResult(handle, { onProgress });
    return this._imagesToResult({ gen, input, out, model: this.anchoredModel, requestId: handle.requestId });
  }

  /**
   * The half of a still render that does not depend on how it was requested:
   * filter the blocked frames, count the megapixels, shape the artifacts.
   */
  _imagesToResult({ gen, input, out, model, requestId }) {
    const images = out.images || [];
    if (!images.length) {
      throw new FalError('fal completed but returned no images', { permanent: true, code: 'NO_OUTPUT' });
    }

    // A content-policy rejection arrives on a 200. Catching it here is the whole
    // reason this check exists rather than trusting the status code.
    const flags = out.has_nsfw_concepts || [];
    const kept = images.filter((_, i) => !flags[i]);
    if (!kept.length) {
      throw new FalError(
        'Every candidate was blocked by the content filter — adjust the wardrobe or pose selections',
        { permanent: true, code: 'CONTENT_FILTERED' }
      );
    }

    // Billed per megapixel ROUNDED UP, per image. Computing it from the actual
    // requested dimensions rather than the tier label is what caught the 1.03 MP
    // free-tier bug — the label said 1 MP and the bill said 2.
    const mpEach = Math.ceil((input.image_size.width * input.image_size.height) / 1_000_000);
    const megapixels = mpEach * kept.length;

    return {
      artifacts: kept.map((img, i) => {
        /**
         * The extension follows the bytes, not our habit.
         *
         * This said `.png` unconditionally while taking the content type from
         * the response. That held while every endpoint took `output_format` and
         * we asked for PNG — the identity-preserving one does not take it and
         * answers JPEG. Storage derives the served content type from the
         * EXTENSION, so a JPEG stored as `.png` is served as `image/png`:
         * browsers sniff past it, and anything that does not, does not.
         */
        const contentType = img.content_type || 'image/png';
        const ext = EXT_BY_TYPE[contentType] || 'png';
        return {
        filename: `${gen.filenamePrefix || 'still'}-${i + 1}.${ext}`,
        contentType,
        url: img.url,
        width: img.width ?? input.image_size.width,
        height: img.height ?? input.image_size.height,
        fetch: () => this._download(img.url),
        };
      }),
      meta: {
        provider: PROVIDER,
        model,
        request_id: requestId,
        seed: out.seed ?? input.seed,
        megapixels,
        seconds_generated: 0,
        cost_cents: megapixels * (model === this.anchoredModel
          ? this.pricing.anchoredPerMegapixelCents
          : this.pricing.stillPerMegapixelCents),
        filtered: images.length - kept.length,
      },
    };
  }

  async runMotion(job, { onProgress } = {}) {
    const gen = job.payload?.generation || {};
    if (!gen.image_url) {
      throw new FalError('Motion job has no generation.image_url to animate', { permanent: true, code: 'NO_INPUT_IMAGE' });
    }

    const seconds = Number(job.payload?.clip_seconds || gen.duration || 5);

    // On local-disk storage this pushes the still through fal's own storage
    // first; on a public bucket it is a no-op.
    // Seedance's image loader is strict and cannot read through ngrok's
    // free-tier browser-warning interstitial — it fails as `image_load_error`.
    // So always hand it a fal.media URL: download our still (a non-browser
    // fetch bypasses ngrok's warning) and re-upload to fal storage. On the ngrok
    // stopgap this is what makes motion work at all; on a real public bucket it
    // is one harmless extra hop. Revisit once S3 replaces the tunnel.
    const imageUrl = await this.ensureFetchable(gen.image_url, {
      publiclyFetchable: false,
      filename: 'source.png',
      contentType: 'image/png',
    });

    const resolution = gen.resolution || '720p';

    const input = {
      image_url: imageUrl,
      prompt: gen.motion_prompt || gen.prompt || '',
      duration: String(seconds),
      resolution,
      ...(gen.seed !== undefined ? { seed: gen.seed } : {}),
    };

    const handle = await this.submit('motion', input);
    const out = await this.waitForResult(handle, { onProgress });

    const video = out.video;
    if (!video || !video.url) {
      throw new FalError('fal completed but returned no video', { permanent: true, code: 'NO_OUTPUT' });
    }

    return {
      artifacts: [{
        filename: `${gen.filenamePrefix || 'clip'}.mp4`,
        contentType: video.content_type || 'video/mp4',
        url: video.url,
        fetch: () => this._download(video.url),
      }],
      meta: {
        provider: PROVIDER,
        model: this.endpoints.motion,
        request_id: handle.requestId,
        seed: out.seed,
        megapixels: 0,
        resolution,
        seconds_generated: seconds,
        cost_cents: seconds * (
          this.pricing.motionPerSecondCentsByResolution[resolution]
          ?? Math.max(...Object.values(this.pricing.motionPerSecondCentsByResolution))
        ),
      },
    };
  }

  /**
   * Train a character LoRA.
   *
   * This is the step that used to require renting a GPU. It does not: fal takes a
   * zip of the seed set and returns a .safetensors we own and can later run on
   * our own hardware — which is the entire reason we are not using a Pro
   * finetune, whose artefact stays inside the provider's account.
   */
  async runLoraTraining(job, { onProgress } = {}) {
    const gen = job.payload?.generation || {};
    if (!gen.images_data_url) {
      throw new FalError('Training job has no generation.images_data_url', { permanent: true, code: 'NO_TRAINING_SET' });
    }
    if (!gen.trigger_word) {
      throw new FalError('Training job has no generation.trigger_word', { permanent: true, code: 'NO_TRIGGER' });
    }

    const imagesUrl = await this.ensureFetchable(gen.images_data_url, {
      publiclyFetchable: gen.publicly_fetchable !== false,
      filename: 'seed-set.zip',
      contentType: 'application/zip',
    });

    const input = {
      images_data_url: imagesUrl,
      trigger_word: gen.trigger_word,
      steps: gen.steps ?? 1000,
      create_masks: gen.create_masks ?? true,
      is_style: false,
    };

    const handle = await this.submit('lora_train', input);
    // Training runs in minutes, not seconds — a longer ceiling and a slower poll.
    const out = await this.waitForResult(handle, { onProgress, timeoutMs: 3_600_000, pollMs: 10_000 });

    const file = out.diffusers_lora_file;
    if (!file || !file.url) {
      throw new FalError('Training completed but returned no LoRA file', { permanent: true, code: 'NO_OUTPUT' });
    }

    return {
      artifacts: [{
        filename: `${gen.trigger_word}.safetensors`,
        contentType: file.content_type || 'application/octet-stream',
        url: file.url,
        fetch: () => this._download(file.url),
      }],
      meta: {
        provider: PROVIDER,
        model: this.endpoints.lora_train,
        request_id: handle.requestId,
        trigger_word: gen.trigger_word,
        steps: input.steps,
        megapixels: 0,
        seconds_generated: 0,
        cost_cents: this.pricing.loraTrainCents,
        config_url: out.config_file?.url || null,
      },
    };
  }

  /** Uniform entry point, so the worker loop does not branch on provider. */
  async run(job, opts = {}) {
    switch (job.stage) {
      case 'still':
      // Same render, same guards — `_stillInput` still refuses a job with no
      // LoRA path, which is exactly what a calibration frame carries.
      case 'calib_still': return this.runStill(job, opts);
      case 'seed_still': return this.runSeedStill(job, opts);
      case 'motion':     return this.runMotion(job, opts);
      case 'lora_train': return this.runLoraTraining(job, opts);
      default:
        throw new FalError(`fal provider does not handle stage "${job.stage}"`, { permanent: true, code: 'UNSUPPORTED_STAGE' });
    }
  }

  /**
   * Put bytes somewhere fal can fetch them.
   *
   * fal's training and image-to-video endpoints take a URL and fetch it
   * themselves. That is fine against a public bucket and impossible against a
   * laptop — `http://127.0.0.1:5000/...` is not reachable from fal's network, and
   * the failure arrives as an unhelpful upstream error rather than "your storage
   * is not public".
   *
   * So when a source is not publicly fetchable, the worker downloads it and
   * pushes it through fal's own storage first. That makes local-disk storage a
   * complete development setup rather than one that works until the first
   * training run.
   */
  async uploadToFalStorage(buffer, { filename = 'upload.bin', contentType = 'application/octet-stream' } = {}) {
    if (!this.apiKey) {
      throw new FalError('FAL_KEY is not set', { permanent: true, code: 'BAD_CREDENTIALS' });
    }

    // `storage_type=fal-cdn-v3` is REQUIRED. Without it fal answers 403 — which
    // reads as "your key is wrong" and is not: 403 on fal means the key is valid
    // but lacks scope for the endpoint as addressed. 401 is the bad-key case.
    if (buffer.length >= MULTIPART_THRESHOLD_BYTES) {
      throw new FalError(
        `${filename} is ${Math.round(buffer.length / 1e6)} MB; fal requires multipart upload above ` +
        `${Math.round(MULTIPART_THRESHOLD_BYTES / 1e6)} MB, which this client does not implement. ` +
        'Reduce the seed set or serve storage from a public URL so fal can fetch it directly.',
        { permanent: true, code: 'FILE_TOO_LARGE' }
      );
    }

    const initiate = await this._request(
      `${this.storageUrl}/upload/initiate?storage_type=${STORAGE_TYPE}`,
      {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ content_type: contentType, file_name: filename }),
      }
    );

    if (!initiate.upload_url || !initiate.file_url) {
      throw new FalError(
        `fal storage did not return an upload target: ${JSON.stringify(initiate).slice(0, 300)}`,
        { permanent: true, code: 'NO_UPLOAD_TARGET' }
      );
    }

    let res;
    try {
      res = await this.fetch(initiate.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: buffer,
      });
    } catch (err) {
      throw new FalError(`fal storage upload failed: ${err.message}`, { cause: err, code: 'UPLOAD_FAILED' });
    }
    if (!res.ok) {
      const { permanent, code } = classifyStatus(res.status);
      throw new FalError(`fal storage upload → ${res.status}`, { permanent, code });
    }

    return initiate.file_url;
  }

  /**
   * Guarantee fal can reach a source.
   *
   * `publiclyFetchable` is decided by the server (it knows which storage driver
   * is configured) and travels on the payload, rather than being guessed here
   * from the shape of a URL.
   */
  async ensureFetchable(source, { publiclyFetchable, filename, contentType }) {
    if (publiclyFetchable) return source;
    const bytes = await this._download(source);
    return this.uploadToFalStorage(bytes, { filename, contentType });
  }

  /** fal returns URLs, not bytes. Download so the worker can re-upload to our storage. */
  async _download(url) {
    let res;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw new FalError(`Cannot download ${url}: ${err.message}`, { cause: err, code: 'DOWNLOAD_FAILED' });
    }
    if (!res.ok) {
      // fal's result URLs expire. A 403/404 here means we took too long between
      // completion and download, which is worth retrying from the top.
      throw new FalError(`Download ${url} → ${res.status}`, { permanent: false, code: 'DOWNLOAD_FAILED' });
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = { FalProvider, FalError, ENDPOINTS, PRICING, classifyStatus, DEFAULT_STORAGE, STORAGE_TYPE, MULTIPART_THRESHOLD_BYTES };
