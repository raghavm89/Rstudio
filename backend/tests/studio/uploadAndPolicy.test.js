'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createUploader, UploadError } = require('../../worker/uploader');
const RunnerPolicy = require('../../src/services/studio/runnerPolicy');
const { validateShots } = require('../../src/controllers/studioShootController');
const Orchestrator = require('../../src/services/studio/orchestrator');

// ── Runner policy — the licence boundary ──────────────────────────────────────

test('stills default to cloud, because dev weights are non-commercial', () => {
  // This is the whole reason runnerPolicy exists. A shoot created through the
  // API is intended to be published, and publishing output from FLUX.1-dev
  // weights is commercial use of a non-commercial licence.
  assert.strictEqual(RunnerPolicy.runnerFor('still'), 'cloud');
  assert.strictEqual(RunnerPolicy.runnerFor('qc'), 'cloud');
  assert.strictEqual(RunnerPolicy.runnerFor('still', { intent: 'cloud' }), 'cloud');
});

test('local generation has to be asked for explicitly', () => {
  assert.strictEqual(RunnerPolicy.runnerFor('still', { intent: 'local' }), 'mac');
  assert.strictEqual(RunnerPolicy.runnerFor('qc', { intent: 'local' }), 'mac');
});

test('qc follows its still onto the same machine', () => {
  for (const intent of ['cloud', 'local']) {
    assert.strictEqual(
      RunnerPolicy.runnerFor('qc', { intent }),
      RunnerPolicy.runnerFor('still', { intent }),
      'shipping the image to another machine to check it buys nothing'
    );
  }
});

test('video is cloud-only regardless of intent — no local video model exists', () => {
  assert.strictEqual(RunnerPolicy.runnerFor('motion', { intent: 'local' }), 'cloud');
  assert.strictEqual(RunnerPolicy.runnerFor('lipsync', { intent: 'local' }), 'cloud');
});

test('a shoot bound to a publishing slot cannot claim to be local R&D', () => {
  assert.throws(
    () => RunnerPolicy.assertIntentAllowed('local', { willPublish: true }),
    (err) => err.status === 409 && err.code === 'LICENCE_INTENT_CONFLICT'
  );
  // And the refusal is not overridable by a third state.
  assert.throws(() => RunnerPolicy.assertIntentAllowed('force', {}), RunnerPolicy.RunnerPolicyError);
  assert.strictEqual(RunnerPolicy.assertIntentAllowed('local', { willPublish: false }), 'local');
});

test('an unknown stage has no runner rather than a silent default', () => {
  // A default here would put an unrecognised stage on some machine and let it
  // run. Refusing surfaces the missing policy at the moment it is added.
  assert.throws(() => RunnerPolicy.runnerFor('deepfake'), RunnerPolicy.RunnerPolicyError);
});

test('the plan routes every licence-bearing stage to cloud by default', () => {
  const { stages } = Orchestrator.planFor({ kind: 'reel', frameCount: 3, clipSeconds: 5 });
  const licenced = stages.filter((s) => RunnerPolicy.LICENCE_BEARING.has(s.stage));
  assert.ok(licenced.length >= 6, 'expected stills and qc in the plan');
  for (const s of licenced) {
    assert.strictEqual(s.runner, 'cloud', `${s.key} must not default to the Mac`);
  }

  const local = Orchestrator.planFor({ kind: 'reel', frameCount: 3, clipSeconds: 5, intent: 'local' });
  for (const s of local.stages.filter((x) => RunnerPolicy.LICENCE_BEARING.has(x.stage))) {
    assert.strictEqual(s.runner, 'mac');
  }
  // Intent must not change the shape of the plan, only where it runs.
  assert.strictEqual(local.stages.length, stages.length);
  assert.strictEqual(local.stepTotal, Orchestrator.planFor({ kind: 'reel', frameCount: 3, clipSeconds: 5 }).stepTotal);
});

// ── Uploader ──────────────────────────────────────────────────────────────────

const artifact = (name = 'a.png', bytes = 'hello') => ({
  filename: name,
  contentType: 'image/png',
  fetch: async () => Buffer.from(bytes),
});

function uploaderWith({ target, putStatus = 200, onPut = null }) {
  const puts = [];
  const requests = [];
  const up = createUploader({
    requestTarget: async (jobId, req) => {
      requests.push({ jobId, ...req });
      return target;
    },
    fetchImpl: async (url, options) => {
      puts.push({ url, options });
      if (onPut) onPut(url, options);
      return { ok: putStatus < 400, status: putStatus, text: async () => 'err' };
    },
  });
  return { up, puts, requests };
}

const TARGET = {
  key: 't1/aanya-kapoor/9/still/1234-a.png',
  url: 'https://storage/presigned',
  headers: { 'Content-Type': 'image/png' },
  public_url: 'https://cdn.rstudio.app/t1/aanya-kapoor/9/still/1234-a.png',
};

test('the worker sends a filename, never a key', async () => {
  // A worker that could nominate its own key could write into another tenant's
  // prefix, and the t{tenant}/… layout exists so the path IS the attribution.
  const { up, requests } = uploaderWith({ target: TARGET });
  await up.upload(42, artifact(), { kind: 'still' });
  assert.deepStrictEqual(Object.keys(requests[0]).sort(), ['contentType', 'filename', 'jobId', 'kind']);
  assert.ok(!('key' in requests[0]));
});

test('an upload returns the public url the publisher will hand to Instagram', async () => {
  const { up } = uploaderWith({ target: TARGET });
  const out = await up.upload(42, artifact(), { kind: 'still' });
  assert.strictEqual(out.url, TARGET.public_url);
  assert.strictEqual(out.key, TARGET.key);
  assert.strictEqual(out.bytes, 5);
});

test('an expired signature is transient, a malformed request is not', async () => {
  const expired = uploaderWith({ target: TARGET, putStatus: 403 });
  await assert.rejects(
    () => expired.up.upload(42, artifact()),
    (err) => err instanceof UploadError && err.permanent === false
  );

  const bad = uploaderWith({ target: TARGET, putStatus: 400 });
  await assert.rejects(() => bad.up.upload(42, artifact()), (err) => err.permanent === true);
});

test('a zero-byte download is refused before it reaches storage', async () => {
  const { up, puts } = uploaderWith({ target: TARGET });
  await assert.rejects(
    () => up.upload(42, { filename: 'e.png', contentType: 'image/png', fetch: async () => Buffer.alloc(0) }),
    (err) => err.permanent === true
  );
  assert.strictEqual(puts.length, 0, 'must not PUT an empty object');
});

test('content-length is set, or S3 rejects a streamed body', async () => {
  const { up, puts } = uploaderWith({ target: TARGET });
  await up.upload(42, artifact('a.png', 'twelve bytes'));
  assert.strictEqual(puts[0].options.headers['Content-Length'], '12');
  assert.strictEqual(puts[0].options.headers['Content-Type'], 'image/png');
  assert.strictEqual(puts[0].options.method, 'PUT');
});

test('uploads run in order and stop at the first failure', async () => {
  let n = 0;
  const { up } = uploaderWith({
    target: TARGET,
    onPut: () => { n += 1; if (n === 2) throw new Error('link died'); },
  });
  await assert.rejects(() => up.uploadAll(42, [artifact('1.png'), artifact('2.png'), artifact('3.png')]));
  assert.strictEqual(n, 2, 'must not keep uploading after a failure');
});

// ── Shoot input validation ────────────────────────────────────────────────────

test('shots are picker selections, never prompt text', () => {
  assert.strictEqual(validateShots([{ framing: 'medium', light_quality: 'soft' }], 4), null);
  assert.match(validateShots([{ framing: 'dutch_angle' }], 4), /framing must be one of/);
  assert.match(validateShots([{ light_direction: 'from_below' }], 4), /light_direction/);
  assert.match(validateShots([{ expression_intensity: 'extreme' }], 4), /expression_intensity/);
});

test('more shots than frames is refused rather than silently truncated', () => {
  // Truncating would drop a shot the customer configured and show them a shoot
  // that does not match what they asked for.
  assert.match(validateShots([{}, {}, {}], 2), /shots has 3 entries but frameCount is 2/);
});

test('advanced_append must be a string, so an object cannot smuggle structure in', () => {
  assert.match(validateShots([{ advanced_append: { $ne: null } }], 4), /must be a string/);
});
