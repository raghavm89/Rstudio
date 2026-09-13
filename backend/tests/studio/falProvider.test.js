'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { FalProvider, FalError, classifyStatus } = require('../../worker/providers/fal');

/** A fetch stub that replays a scripted sequence and records what it was asked. */
function stubFetch(script) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, options = {}) => {
    // Bodies are JSON on the API calls and raw bytes on the storage PUT.
    let body = null;
    if (options.body) {
      try { body = JSON.parse(options.body); } catch { body = options.body; }
    }
    calls.push({ url, options, body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra fetch to ${url}`);
    if (typeof next === 'function') return next(url, options);
    if (next.throws) throw new Error(next.throws);
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => next.json,
      text: async () => next.text ?? JSON.stringify(next.json ?? {}),
      arrayBuffer: async () => next.buffer ?? Buffer.from('x'),
    };
  };
  return { fetchImpl, calls };
}

const provider = (script, opts = {}) => {
  const { fetchImpl, calls } = stubFetch(script);
  return {
    p: new FalProvider({ apiKey: 'test-key', fetchImpl, ...opts }),
    calls,
  };
};

const SUBMITTED = {
  json: { request_id: 'req-1', status_url: 'https://q/status', response_url: 'https://q/result' },
};
const COMPLETED = { json: { status: 'COMPLETED' } };

const stillJob = (overrides = {}) => ({
  id: 1,
  stage: 'still',
  payload: {
    generation: {
      prompt: 'a4ny4prsn, 26 year old North Indian woman, ...',
      width: 880, height: 1104,
      seed: 42,
      candidates: 1,
      lora: { path: 'https://storage/aanya_v1.safetensors', scale: 0.95 },
      ...overrides,
    },
  },
});

// ── Error classification ──────────────────────────────────────────────────────

test('a bad key is permanent, a busy queue is not', () => {
  // Marking 401 transient would leave every job silently cycling until the
  // attempt budget ran out, which reads as "generation is slow" rather than
  // "your key is wrong".
  assert.strictEqual(classifyStatus(401).permanent, true);
  assert.strictEqual(classifyStatus(403).permanent, true);
  assert.strictEqual(classifyStatus(422).permanent, true);
  assert.strictEqual(classifyStatus(404).permanent, true);

  assert.strictEqual(classifyStatus(429).permanent, false);
  assert.strictEqual(classifyStatus(500).permanent, false);
  assert.strictEqual(classifyStatus(503).permanent, false);
});

test('a network failure is transient, not a dead job', async () => {
  const { p } = provider([{ throws: 'ECONNRESET' }]);
  await assert.rejects(
    () => p.submit('still', {}),
    (err) => err instanceof FalError && err.permanent === false && err.code === 'UNREACHABLE'
  );
});

test('a missing key is refused before any request is made', async () => {
  const { p, calls } = provider([]);
  p.apiKey = '';
  await assert.rejects(() => p.submit('still', {}), (e) => e.permanent && e.code === 'BAD_CREDENTIALS');
  assert.strictEqual(calls.length, 0, 'must not call fal without a key');
});

// ── Stills ────────────────────────────────────────────────────────────────────

test('a still is submitted with the prompt, lora and dimensions unchanged', async () => {
  const { p, calls } = provider([
    SUBMITTED,
    COMPLETED,
    { json: { images: [{ url: 'https://cdn/1.png', width: 880, height: 1104 }], seed: 42 } },
  ]);

  const out = await p.runStill(stillJob());
  const submit = calls[0].body;

  // The identity block must reach the model byte-identical regardless of
  // provider — that is the whole guarantee buildWorkflow exists to make.
  assert.strictEqual(submit.prompt, stillJob().payload.generation.prompt);
  assert.deepStrictEqual(submit.image_size, { width: 880, height: 1104 });
  assert.deepStrictEqual(submit.loras, [{ path: 'https://storage/aanya_v1.safetensors', scale: 0.95 }]);
  assert.strictEqual(submit.seed, 42);
  assert.strictEqual(out.artifacts.length, 1);
  assert.strictEqual(out.meta.provider, 'fal');
});

test('cost is computed from actual pixels, not the tier label', async () => {
  // 880x1104 = 0.97 MP → bills as 1. The free tier drafted at 896x1152 = 1.03 MP
  // would have billed as 2 and cost exactly what paid costs. Guard the number.
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { images: [{ url: 'https://cdn/1.png' }] } },
  ]);
  const free = await p.runStill(stillJob());
  assert.strictEqual(free.meta.megapixels, 1);
  assert.strictEqual(free.meta.cost_cents, 3.5);

  const { p: p2 } = provider([
    SUBMITTED, COMPLETED,
    { json: { images: [{ url: 'https://cdn/1.png' }, { url: 'https://cdn/2.png' }] } },
  ]);
  const paid = await p2.runStill(stillJob({ width: 1024, height: 1280, candidates: 2 }));
  // 1.31 MP each, rounded up to 2, times two images.
  assert.strictEqual(paid.meta.megapixels, 4);
  assert.strictEqual(paid.meta.cost_cents, 14);
});

test('fractional cents survive — an integer would bias the self-hosting analysis', async () => {
  const { p } = provider([SUBMITTED, COMPLETED, { json: { images: [{ url: 'u' }] } }]);
  const out = await p.runStill(stillJob());
  assert.ok(!Number.isInteger(out.meta.cost_cents), '3.5c must not be rounded at the source');
});

test('a content-policy rejection on a 200 is a permanent failure, not a blank image', async () => {
  // fal reports this on a SUCCESSFUL request. Trusting the status code would
  // hand the pipeline a blocked image and let QC blame the LoRA.
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { images: [{ url: 'https://cdn/1.png' }], has_nsfw_concepts: [true] } },
  ]);
  await assert.rejects(
    () => p.runStill(stillJob()),
    (err) => err.permanent === true && err.code === 'CONTENT_FILTERED'
  );
});

test('a partially filtered batch keeps the survivors and bills only for them', async () => {
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { images: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], has_nsfw_concepts: [false, true, false] } },
  ]);
  const out = await p.runStill(stillJob({ candidates: 3 }));
  assert.strictEqual(out.artifacts.length, 2);
  assert.strictEqual(out.meta.filtered, 1);
  assert.strictEqual(out.meta.megapixels, 2, 'must not bill for the filtered candidate');
});

test('a still without a LoRA is refused — a faceless persona is not a render', async () => {
  const { p, calls } = provider([]);
  const job = stillJob();
  delete job.payload.generation.lora;
  await assert.rejects(() => p.runStill(job), (e) => e.permanent && e.code === 'NO_LORA');
  assert.strictEqual(calls.length, 0, 'must refuse before spending a request');
});

test('an execution error from the queue is permanent', async () => {
  const { p } = provider([SUBMITTED, { json: { status: 'ERROR', error: { detail: 'bad lora url' } } }]);
  await assert.rejects(
    () => p.runStill(stillJob()),
    (err) => err.permanent === true && err.code === 'EXECUTION_FAILED'
  );
});

test('polling heartbeats through onProgress so a long render keeps its lease', async () => {
  let beats = 0;
  const { p } = provider([
    SUBMITTED,
    { json: { status: 'IN_QUEUE' } },
    { json: { status: 'IN_PROGRESS' } },
    COMPLETED,
    { json: { images: [{ url: 'u' }] } },
  ]);
  await p.runStill(stillJob(), { onProgress: async () => { beats += 1; } });
  assert.strictEqual(beats, 2, 'each non-terminal poll must offer a heartbeat');
});

// ── Motion ────────────────────────────────────────────────────────────────────

test('🐛 motion bills by RESOLUTION — a flat rate understated 720p by 2.5x', async () => {
  // fal bills video by tokens: (h x w x fps x duration), so resolution sets
  // the per-second cost. Seedance 2.0 Mini: 480p 7.21c/s, 720p 15.47c/s
  // (fal rate card, Sep 2026). The old flat 2.2c/s was deprecated v1 /lite and
  // under-reported the one column the self-hosting analysis reads.
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { video: { url: 'https://cdn/clip.mp4' } } },
  ]);
  const out = await p.runMotion({
    id: 2, stage: 'motion',
    payload: { clip_seconds: 5, generation: {
      image_url: 'https://cdn/still.png', motion_prompt: 'slow push in', publicly_fetchable: true,
    } },
  });
  assert.strictEqual(out.meta.seconds_generated, 5);
  assert.strictEqual(out.meta.resolution, '720p');
  assert.strictEqual(out.meta.cost_cents, 5 * 15.47, '5s at 720p Mini is 77.35c, not the old flat-rate 11c');
  assert.strictEqual(out.artifacts[0].contentType, 'video/mp4');

  const { p: p2, calls } = provider([]);
  await assert.rejects(
    () => p2.runMotion({ id: 3, stage: 'motion', payload: { generation: {} } }),
    (e) => e.permanent && e.code === 'NO_INPUT_IMAGE'
  );
  assert.strictEqual(calls.length, 0);
});

test('each resolution tier bills at its own rate', async () => {
  // Seedance 2.0 Mini tops out at 720p; 480p 7.21c/s -> 36c, 720p 15.47c/s -> 77c for 5s.
  for (const [resolution, expected] of [['480p', 36], ['720p', 77]]) {
    const { p } = provider([SUBMITTED, COMPLETED, { json: { video: { url: 'u' } } }]);
    const out = await p.runMotion({
      id: 4, stage: 'motion',
      payload: { clip_seconds: 5, generation: { image_url: 'u', resolution, publicly_fetchable: true } },
    });
    assert.strictEqual(Math.round(out.meta.cost_cents), expected, `${resolution} mispriced`);
  }
});

test('an unknown resolution bills at the HIGHEST rate, never the lowest', async () => {
  // Guessing low on an unrecognised tier quietly under-reports spend, and the
  // one number this system must not flatter is its own cost.
  const { p } = provider([SUBMITTED, COMPLETED, { json: { video: { url: 'u' } } }]);
  const out = await p.runMotion({
    id: 5, stage: 'motion',
    payload: { clip_seconds: 5, generation: { image_url: 'u', resolution: '4k', publicly_fetchable: true } },
  });
  assert.strictEqual(out.meta.cost_cents, 5 * 15.47);
});

test('the configured video endpoint is not the deprecated lite one', async () => {
  // fal deprecated seedance/v1/lite and re-routes it. Pinning a dead endpoint
  // works until it does not, and then fails as an unhelpful upstream error.
  const { ENDPOINTS } = require('../../worker/providers/fal');
  assert.ok(!/\/lite\//.test(ENDPOINTS.motion), `motion endpoint is deprecated: ${ENDPOINTS.motion}`);
});

// ── LoRA training ─────────────────────────────────────────────────────────────

test('training returns a file we own, which is why we are not using a Pro finetune', async () => {
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { diffusers_lora_file: { url: 'https://cdn/aanya.safetensors' }, config_file: { url: 'https://cdn/c.json' } } },
  ]);
  const out = await p.runLoraTraining({
    id: 4, stage: 'lora_train',
    payload: { generation: { images_data_url: 'https://cdn/seed.zip', trigger_word: 'a4ny4prsn' } },
  });
  // A downloadable .safetensors is the artefact that makes the eventual move to
  // our own GPUs possible. A Pro finetune_id would not be.
  assert.match(out.artifacts[0].filename, /\.safetensors$/);
  assert.ok(out.artifacts[0].url);
  assert.strictEqual(out.meta.trigger_word, 'a4ny4prsn');
});

test('training refuses without a seed set or a trigger word', async () => {
  const { p } = provider([]);
  await assert.rejects(
    () => p.runLoraTraining({ id: 5, stage: 'lora_train', payload: { generation: { trigger_word: 'x' } } }),
    (e) => e.permanent && e.code === 'NO_TRAINING_SET'
  );
  await assert.rejects(
    () => p.runLoraTraining({ id: 6, stage: 'lora_train', payload: { generation: { images_data_url: 'u' } } }),
    (e) => e.permanent && e.code === 'NO_TRIGGER'
  );
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

test('an unsupported stage is refused rather than silently doing nothing', async () => {
  const { p } = provider([]);
  await assert.rejects(
    () => p.run({ id: 7, stage: 'lipsync', payload: {} }),
    (e) => e.permanent && e.code === 'UNSUPPORTED_STAGE'
  );
});

test('an expired result URL is transient — the render succeeded, the download did not', async () => {
  const { p } = provider([
    SUBMITTED, COMPLETED,
    { json: { images: [{ url: 'https://cdn/1.png' }] } },
    { status: 403, text: 'expired' },
  ]);
  const out = await p.runStill(stillJob());
  await assert.rejects(
    () => out.artifacts[0].fetch(),
    (err) => err.permanent === false && err.code === 'DOWNLOAD_FAILED'
  );
});

// ── fal storage (the local-disk escape hatch) ─────────────────────────────────

test('🐛 the storage endpoint carries storage_type — without it fal answers 403', async () => {
  // This cost a debugging round trip. A 403 from fal means the key is VALID but
  // lacks scope for the endpoint as addressed; 401 is the bad-key case. Omitting
  // storage_type made a correct key look revoked.
  const { p, calls } = provider([
    { json: { upload_url: 'https://up/1', file_url: 'https://cdn.fal/1.zip' } },
    { status: 200 },
  ]);
  const url = await p.uploadToFalStorage(Buffer.from('zip'), { filename: 's.zip', contentType: 'application/zip' });

  assert.match(calls[0].url, /storage_type=fal-cdn-v3/);
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].body, { content_type: 'application/zip', file_name: 's.zip' });
  assert.strictEqual(calls[1].options.method, 'PUT', 'the bytes go to the returned upload_url');
  assert.strictEqual(url, 'https://cdn.fal/1.zip');
});

test('a file too large for a single PUT is refused with the reason, not a stuck job', async () => {
  const { p } = provider([]);
  const huge = Buffer.alloc(91 * 1024 * 1024);
  await assert.rejects(
    () => p.uploadToFalStorage(huge, { filename: 'big.zip' }),
    (e) => e.permanent === true && e.code === 'FILE_TOO_LARGE' && /multipart/.test(e.message)
  );
});

test('ensureFetchable is a no-op on public storage and a round trip on local disk', async () => {
  const passthrough = provider([]);
  assert.strictEqual(
    await passthrough.p.ensureFetchable('https://media.rstudio.app/a.png', { publiclyFetchable: true }),
    'https://media.rstudio.app/a.png',
    'a public bucket must not pay for a pointless upload'
  );

  const { p, calls } = provider([
    { buffer: Buffer.from('png bytes') },                                     // download from our API
    { json: { upload_url: 'https://up/2', file_url: 'https://cdn.fal/2.png' } },
    { status: 200 },
  ]);
  const out = await p.ensureFetchable('http://127.0.0.1:5000/api/studio/files/t1/a.png', {
    publiclyFetchable: false, filename: 'source.png', contentType: 'image/png',
  });
  assert.strictEqual(out, 'https://cdn.fal/2.png');
  assert.strictEqual(calls.length, 3, 'download, initiate, put');
});

test('a local-disk still is routed through fal storage before image-to-video', async () => {
  // fal FETCHES the source image. 127.0.0.1 is not reachable from fal's network,
  // and the failure would arrive as an opaque upstream error rather than
  // "your storage is not public".
  const { p, calls } = provider([
    { buffer: Buffer.from('png') },
    { json: { upload_url: 'https://up/3', file_url: 'https://cdn.fal/3.png' } },
    { status: 200 },
    SUBMITTED, COMPLETED,
    { json: { video: { url: 'https://cdn/clip.mp4' } } },
  ]);
  await p.runMotion({
    id: 9, stage: 'motion',
    payload: { clip_seconds: 5, generation: {
      image_url: 'http://127.0.0.1:5000/api/studio/files/t1/a.png',
      publicly_fetchable: false,
    } },
  });
  const submit = calls.find((c) => c.body && c.body.image_url);
  assert.strictEqual(submit.body.image_url, 'https://cdn.fal/3.png',
    'fal must be handed a URL it can actually reach');
});
