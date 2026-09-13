'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool         = require('../../src/config/db');
const RenderJob    = require('../../src/models/renderJob');
const StudioUsage  = require('../../src/models/studioUsage');
const Orchestrator = require('../../src/services/studio/orchestrator');
const FaceQc       = require('../../src/services/studio/faceQc');
const { Storage }  = require('../../src/services/studio/storage');

let TENANT, AVATAR, LORA;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('studio-svc-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;

  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, lora_trigger)
     VALUES ($1,'svc-avatar','Svc Avatar','synthetic','active','26 year old woman','sv4tk') RETURNING id`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;

  const l = await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'svc_v1.safetensors','sv4tk','flux1-dev.safetensors',TRUE) RETURNING id`,
    [AVATAR]
  );
  LORA = l.rows[0].id;

  await pool.query(`INSERT INTO look_profiles (avatar_id) VALUES ($1)`, [AVATAR]);
  // Generous CREDIT wallet so orchestration tests are not fighting the free
  // tier's 40. Content is metered in one `credits` wallet now (migration 056),
  // not the per-unit video_seconds/still_megapixels counters.
  await pool.query(
    `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
     VALUES (NULL,'credits',100000,'month')
     ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`
  );
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.query(
    `UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`
  );
  await pool.end();
});

const reset = async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
};

// ── Orchestrator ──────────────────────────────────────────────────────────────

test('one click writes the whole plan: project, scene, shots and the job graph', async () => {
  await reset();
  const out = await Orchestrator.createShoot({
    tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 3, tier: 'paid',
    brief: { title: 'Gym to café' }, scene: { location_key: 'cafe' },
  });

  assert.strictEqual(out.shots.length, 3);
  assert.strictEqual(out.project.kind, 'reel');
  // 1 prompt + 3 still + 3 qc + 3 motion + 1 voice + 1 assemble + 1 copy
  assert.strictEqual(out.job_count, 13);

  const { rows } = await pool.query(
    `SELECT stage, COUNT(*)::int n FROM render_jobs WHERE project_id = $1 GROUP BY stage`,
    [out.project.id]
  );
  const byStage = Object.fromEntries(rows.map((r) => [r.stage, r.n]));
  assert.deepStrictEqual(byStage, { prompt: 1, still: 3, qc: 3, motion: 3, voice: 1, assemble: 1, copy: 1 });
});

test('only the prompt stage is claimable at the start — dependencies gate the rest', async () => {
  await reset();
  await Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 2, tier: 'paid' });

  // Stills and qc run on `cloud` by default — see runnerPolicy.js: dev weights
  // are non-commercial, so published work goes to fal's licensed endpoint.
  // Neither is ready until prompt is done.
  assert.strictEqual(
    await RenderJob.claimNext({ runner: 'cloud', stages: ['still', 'qc'], workerId: 'w1' }),
    null,
    'stills must wait for the prompt stage'
  );

  const prompt = await RenderJob.claimNext({ runner: 'server', workerId: 'srv' });
  assert.strictEqual(prompt.stage, 'prompt');
  await RenderJob.complete(prompt.id, 'srv', {});

  const still = await RenderJob.claimNext({ runner: 'cloud', stages: ['still'], workerId: 'w1' });
  assert.ok(still, 'stills unlock once the prompt stage completes');
  assert.strictEqual(still.stage, 'still');
});

test('assemble waits for every clip — fan-in, not just fan-out', async () => {
  await reset();
  const out = await Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 2, tier: 'paid' });

  const drain = async (runner, stages) => {
    const jobs = [];
    for (;;) {
      const j = await RenderJob.claimNext({ runner, stages, workerId: 'w' });
      if (!j) break;
      await RenderJob.complete(j.id, 'w', {});
      jobs.push(j);
    }
    return jobs;
  };

  await drain('server', ['prompt']);
  await drain('cloud', ['still']);
  await drain('cloud', ['qc']);

  // One clip done, one still outstanding: assemble must not be claimable.
  const motion = await RenderJob.claimNext({ runner: 'cloud', stages: ['motion'], workerId: 'c' });
  await RenderJob.complete(motion.id, 'c', { seconds_generated: 5 });
  await drain('server', ['voice']);
  assert.strictEqual(
    await RenderJob.claimNext({ runner: 'server', stages: ['assemble'], workerId: 's' }),
    null,
    'a reel is not a reel until every clip exists'
  );

  const motion2 = await RenderJob.claimNext({ runner: 'cloud', stages: ['motion'], workerId: 'c' });
  await RenderJob.complete(motion2.id, 'c', { seconds_generated: 5 });
  assert.ok(
    await RenderJob.claimNext({ runner: 'server', stages: ['assemble'], workerId: 's' }),
    'assemble unlocks when the last clip lands'
  );
  assert.ok(out.project.id);
});

test('a permanent failure blocks everything downstream instead of hanging it', async () => {
  await reset();
  const out = await Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'reel', frameCount: 1, tier: 'paid' });

  const prompt = await RenderJob.claimNext({ runner: 'server', workerId: 's' });
  await RenderJob.complete(prompt.id, 's', {});

  const still = await RenderJob.claimNext({ runner: 'cloud', stages: ['still'], workerId: 'w' });
  await RenderJob.fail(still.id, 'w', 'LoRA file missing', { permanent: true });

  const client = await pool.connect();
  try { await RenderJob.blockDependentsTx(client, still.id); }
  finally { client.release(); }

  const { rows } = await pool.query(
    `SELECT stage, status FROM render_jobs WHERE project_id = $1 ORDER BY id`, [out.project.id]
  );
  const blocked = rows.filter((r) => r.status === 'blocked').map((r) => r.stage);
  // qc → motion → assemble → copy all descend from the failed still.
  assert.deepStrictEqual(blocked.sort(), ['assemble', 'copy', 'motion', 'qc']);
  assert.ok(!rows.some((r) => r.status === 'queued' && r.stage !== 'voice'),
    'nothing downstream should be left waiting on a job that will never finish');
});

test('quota for the whole plan is reserved up front, and a refusal creates nothing', async () => {
  await reset();
  // A 4-frame post is 4 stills = 4 credits (creditCost.js). Cap the wallet at 3
  // and the whole shoot must be refused up front — one atomic reserve, not four.
  await pool.query(
    `UPDATE studio_entitlements SET limit_value = 3 WHERE plan_id IS NULL AND metric = 'credits'`
  );
  try {
    await assert.rejects(
      () => Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 4, tier: 'paid' }),
      (err) => err.code === 'QUOTA_EXCEEDED'
    );
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM studio_projects WHERE tenant_id = $1', [TENANT]);
    assert.strictEqual(rows[0].n, 0, 'a refused shoot must not leave a half-created project behind');
  } finally {
    await pool.query(
      `UPDATE studio_entitlements SET limit_value = 100000 WHERE plan_id IS NULL AND metric = 'credits'`
    );
  }
});

test('an avatar without a trained model is refused before quota is spent', async () => {
  await reset();
  const { rows } = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, identity_block)
     VALUES ($1,'no-lora','No LoRA','synthetic','x') RETURNING id`, [TENANT]
  );
  await assert.rejects(
    () => Orchestrator.createShoot({ tenantId: TENANT, avatarId: rows[0].id, kind: 'post', frameCount: 1 }),
    (err) => err.status === 409 && /no trained model/.test(err.message)
  );
  const counters = await pool.query('SELECT COUNT(*)::int n FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  assert.strictEqual(counters.rows[0].n, 0);
  await pool.query('DELETE FROM avatars WHERE id = $1', [rows[0].id]);
});

test('a twin persona without verified consent cannot generate at all', async () => {
  await reset();
  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, identity_block)
     VALUES ($1,'twin-avatar','Twin','twin','x') RETURNING id`, [TENANT]
  );
  await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'t.safetensors','tw','flux1-dev.safetensors',TRUE)`, [a.rows[0].id]
  );
  await pool.query(`INSERT INTO look_profiles (avatar_id) VALUES ($1)`, [a.rows[0].id]);

  await assert.rejects(
    () => Orchestrator.createShoot({ tenantId: TENANT, avatarId: a.rows[0].id, kind: 'post', frameCount: 1 }),
    (err) => err.status === 403 && /consent/.test(err.message)
  );
  await pool.query('DELETE FROM avatars WHERE id = $1', [a.rows[0].id]);
});

test('progress groups jobs into steps the UI can render', async () => {
  await reset();
  const out = await Orchestrator.createShoot({ tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 2, tier: 'paid' });

  let p = await Orchestrator.progress(TENANT, out.project.id);
  assert.strictEqual(p.percent, 0);
  assert.ok(p.steps.length >= 2);
  assert.strictEqual(p.steps[0].label, 'Working out the shots');

  const prompt = await RenderJob.claimNext({ runner: 'server', workerId: 's' });
  await RenderJob.complete(prompt.id, 's', {});
  p = await Orchestrator.progress(TENANT, out.project.id);
  assert.strictEqual(p.steps[0].status, 'done');
  assert.ok(p.percent > 0 && p.percent < 100);
});

// ── Face QC ───────────────────────────────────────────────────────────────────

test('cosine similarity: identical is 1, orthogonal is 0, magnitude is irrelevant', () => {
  assert.strictEqual(FaceQc.cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.strictEqual(FaceQc.cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  // Face embeddings carry identity in direction, not length.
  assert.ok(Math.abs(FaceQc.cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
});

test('mismatched embedding lengths throw rather than silently comparing garbage', () => {
  assert.throws(() => FaceQc.cosineSimilarity([1, 2], [1, 2, 3]), RangeError);
});

test('structural failures are caught before similarity is even computed', async () => {
  const base = { avatarId: AVATAR, loraId: LORA, embedding: [1, 0], referenceEmbedding: [1, 0] };
  for (const [detections, reason] of [
    [{ faceCount: 0 }, FaceQc.REJECT.NO_FACE],
    [{ faceCount: 2 }, FaceQc.REJECT.MULTIPLE_FACES],
    [{ faceCount: 1, malformedHands: true }, FaceQc.REJECT.MALFORMED_HANDS],
    [{ faceCount: 1, textArtifact: true }, FaceQc.REJECT.TEXT_ARTIFACT],
  ]) {
    const v = await FaceQc.evaluate({ ...base, detections });
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.reason, reason);
    assert.strictEqual(v.similarity, null, 'no point scoring an image that is structurally wrong');
  }
});

test('an uncalibrated persona uses a permissive floor and says so', async () => {
  const v = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'laughing', framing: 'medium',
    embedding: [0.9, 0.1], referenceEmbedding: [1, 0], detections: { faceCount: 1 },
  });
  assert.strictEqual(v.baselineSource, 'uncalibrated');
  assert.strictEqual(v.calibrated, false);
  assert.strictEqual(v.floor, FaceQc.UNCALIBRATED_FLOOR);
});

test('calibration stores the mean and a bounded tolerance', async () => {
  const b = await FaceQc.calibrate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'laughing', framing: 'medium',
    similarities: [0.90, 0.88, 0.91, 0.89, 0.92],
  });
  assert.ok(Math.abs(Number(b.expected_similarity) - 0.90) < 0.01);
  assert.ok(Number(b.tolerance) >= 0.03, 'a tight sample must not produce an impassable gate');
  assert.ok(Number(b.tolerance) <= 0.15, 'a noisy sample must not produce a gate that lets anything through');
  assert.strictEqual(b.sample_count, 5);
});

test('THE BUG THIS EXISTS TO PREVENT: an emotional shot is judged against its own baseline', async () => {
  // Neutral sits high; crying legitimately sits lower because the geometry moved.
  await FaceQc.calibrate({ avatarId: AVATAR, loraId: LORA, presetKey: 'neutral', framing: 'medium',
    similarities: [0.95, 0.96, 0.94, 0.95, 0.95] });
  await FaceQc.calibrate({ avatarId: AVATAR, loraId: LORA, presetKey: 'crying', framing: 'medium',
    similarities: [0.82, 0.81, 0.83, 0.80, 0.82] });

  // A frame scoring 0.81 — plainly fine for crying, plainly wrong for neutral.
  const a = [Math.cos(0.1), Math.sin(0.1)];
  const ref = [1, 0];
  const sim = FaceQc.cosineSimilarity(a, ref);
  assert.ok(sim > 0.99); // control: the maths works

  const crying = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'crying', framing: 'medium',
    embedding: a, referenceEmbedding: ref, detections: { faceCount: 1 },
  });
  assert.strictEqual(crying.baselineSource, 'exact');
  assert.ok(Math.abs(crying.expected - 0.816) < 0.02, `crying baseline should be ~0.816, got ${crying.expected}`);

  const neutral = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'neutral', framing: 'medium',
    embedding: a, referenceEmbedding: ref, detections: { faceCount: 1 },
  });
  assert.ok(neutral.expected > crying.expected + 0.10,
    'the two expectations must differ, or one flat threshold silently eats every emotional shot');
});

test('an uncalibrated framing falls back to the same expression, never to neutral', async () => {
  const v = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'crying', framing: 'wide',
    embedding: [1, 0], referenceEmbedding: [1, 0], detections: { faceCount: 1 },
  });
  assert.strictEqual(v.baselineSource, 'expression');
  assert.ok(v.expected < 0.9, 'falling back to a neutral baseline would reject valid crying frames');
});

test('the setup checklist reports which presets still need calibrating', async () => {
  const left = await FaceQc.uncalibratedPresets(AVATAR, LORA);
  assert.ok(Array.isArray(left));
  assert.ok(!left.includes('crying'), 'crying was calibrated above');
  assert.ok(left.includes('shy'), 'shy was not');

  // And it counts only presets the vocabulary can prompt. It used to count
  // every enabled one — the most generous of the three answers this codebase
  // had to that question — so a preset nothing could generate would sit on the
  // checklist permanently, a line nobody can ever tick. Migration 053.
  const { rows: unseeded } = await pool.query(
    `SELECT key FROM expression_presets p
      WHERE (p.tenant_id = $1 OR p.tenant_id IS NULL) AND p.enabled
        AND NOT EXISTS (SELECT 1 FROM prompt_vocabulary v
                         WHERE v.facet = 'expression' AND v.option_key = p.key AND v.active)`,
    [TENANT]
  );
  for (const p of unseeded) {
    assert.ok(!left.includes(p.key), `"${p.key}" cannot be generated, so it is not a gap in calibration`);
  }
});

// ── Storage ───────────────────────────────────────────────────────────────────

const S3 = () => new Storage({
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  region: 'auto', bucket: 'studio-media',
  accessKeyId: 'AKIAEXAMPLE', secretKey: 'secretkeyexample',
  publicBase: 'https://media.rstudio.app', forcePathStyle: true,
});

test('presigned PUT carries every parameter S3 requires', () => {
  const url = new URL(S3().presign('PUT', 't1/aanya/9/still/x.png', { now: new Date('2026-09-08T10:00:00Z') }));
  const q = url.searchParams;
  assert.strictEqual(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.strictEqual(q.get('X-Amz-Date'), '20260908T100000Z');
  assert.strictEqual(q.get('X-Amz-Expires'), '900');
  assert.strictEqual(q.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(q.get('X-Amz-Credential').startsWith('AKIAEXAMPLE/20260908/auto/s3/aws4_request'));
  assert.match(q.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.strictEqual(url.pathname, '/studio-media/t1/aanya/9/still/x.png');
});

test('signing is deterministic, and any change to the request changes the signature', () => {
  const s = S3();
  const now = new Date('2026-09-08T10:00:00Z');
  const sig = (u) => new URL(u).searchParams.get('X-Amz-Signature');

  const a = sig(s.presign('PUT', 'k/a.png', { now }));
  assert.strictEqual(a, sig(s.presign('PUT', 'k/a.png', { now })), 'same inputs must sign identically');
  assert.notStrictEqual(a, sig(s.presign('GET', 'k/a.png', { now })), 'method is signed');
  assert.notStrictEqual(a, sig(s.presign('PUT', 'k/b.png', { now })), 'key is signed');
  assert.notStrictEqual(a, sig(s.presign('PUT', 'k/a.png', { now, expiresIn: 60 })), 'expiry is signed');
  assert.notStrictEqual(a, sig(s.presign('PUT', 'k/a.png', { now, contentType: 'image/png' })), 'content-type is signed');
});

test('content-type, when given, is signed so a PUT cannot smuggle another type', () => {
  const url = S3().presign('PUT', 'k/a.png', { contentType: 'image/png' });
  assert.match(url, /X-Amz-SignedHeaders=content-type%3Bhost/);
});

test('keys that need escaping do not break the signature', () => {
  // encodeURIComponent leaves ' ( ) ! * alone; AWS does not. A filename with an
  // apostrophe is exactly how this bug reaches production.
  const url = S3().presign('PUT', "t1/aanya/9/still/it's (final)*.png");
  assert.ok(!url.includes("'"), 'apostrophe must be percent-encoded');
  assert.ok(!url.includes('('), 'parenthesis must be percent-encoded');
  assert.match(url, /%27/);
});

test('uploadTarget returns a usable envelope with a stable public URL', () => {
  const t = S3().uploadTarget({
    tenantId: 7, avatarSlug: 'aanya-kapoor', projectId: 42, kind: 'reel',
    filename: 'final cut.mp4', contentType: 'video/mp4',
  });
  assert.ok(t.key.startsWith('t7/aanya-kapoor/42/reel/'));
  assert.ok(t.key.endsWith('final_cut.mp4'), 'unsafe characters are normalised out of the key');
  assert.strictEqual(t.method, 'PUT');
  assert.strictEqual(t.headers['Content-Type'], 'video/mp4');
  // Instagram FETCHES media from a URL, so this has to be public and stable.
  assert.strictEqual(t.public_url, `https://media.rstudio.app/${t.key}`);
  assert.ok(!t.public_url.includes('X-Amz-Signature'), 'the published URL must not be a signed one');
});

test('the tenant is the first path segment, so storage is attributable without the DB', () => {
  const key = S3().keyFor({ tenantId: 12, avatarSlug: 'x', projectId: 3, kind: 'still', filename: 'a.png' });
  assert.match(key, /^t12\//);
});

test('unconfigured storage fails loudly rather than writing somewhere surprising', () => {
  const s = new Storage({ endpoint: '', bucket: '', accessKeyId: '', secretKey: '' });
  assert.strictEqual(s.configured, false);
  assert.throws(() => s.presign('PUT', 'k'), /not configured/);
});

test('an absurd expiry is refused', () => {
  assert.throws(() => S3().presign('PUT', 'k', { expiresIn: 0 }), RangeError);
  assert.throws(() => S3().presign('PUT', 'k', { expiresIn: 604801 }), RangeError);
});
