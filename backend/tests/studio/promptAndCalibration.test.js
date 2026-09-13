'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pool         = require('../../src/config/db');
const RenderJob    = require('../../src/models/renderJob');
const Orchestrator = require('../../src/services/studio/orchestrator');
const PromptStage  = require('../../src/services/studio/promptStage');
const { ServerRunner } = require('../../src/services/studio/serverRunner');
const Calibration  = require('../../src/services/studio/calibration');
const FaceQc       = require('../../src/services/studio/faceQc');

let TENANT, AVATAR, LORA;

function embedding(seed, drift = 0) {
  const out = new Array(512);
  for (let i = 0; i < 512; i += 1) {
    out[i] = Math.sin(i * 0.7 + 1) + drift * Math.sin(i * 3.1 + seed);
  }
  return out;
}

const REFERENCE = embedding(0, 0);

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('studio-prompt-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;

  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block, lora_trigger)
     VALUES ($1,'prompt-avatar','Prompt Avatar','synthetic','active',
             '26 year old North Indian woman, warm medium-brown skin, oval face with a defined jawline, dark brown almond eyes',
             'extra fingers, deformed hands','p4tk9x') RETURNING id`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;

  const l = await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint,
                               seed_set_count, face_embedding_mean, active)
     VALUES ($1,1,'https://cdn/p.safetensors','p4tk9x','flux1-dev.safetensors',16,$2::jsonb,TRUE)
     RETURNING id`,
    [AVATAR, JSON.stringify(REFERENCE)]
  );
  LORA = l.rows[0].id;

  await pool.query(
    `INSERT INTO look_profiles (avatar_id, base_look, lens, colour, grain, skin, natural_asymmetry, hair_detail)
     VALUES ($1,'editorial','portrait_85','warm','fine','natural',TRUE,TRUE)
     ON CONFLICT (avatar_id) DO NOTHING`,
    [AVATAR]
  );
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

async function reset() {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
}

const shoot = (over = {}) => Orchestrator.createShoot({
  tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 3, tier: 'paid',
  scene: { location_key: 'cafe', time_of_day: 'afternoon',
           continuity: { location_text: 'corner cafe in Bandra', wardrobe_text: 'cropped charcoal tee' } },
  shots: [
    { framing: 'close',  expression_key: 'neutral' },
    { framing: 'medium', expression_key: 'laughing' },
    { framing: 'wide',   expression_key: 'neutral' },
  ],
  ...over,
});

// ── The prompt stage ──────────────────────────────────────────────────────────

test('the prompt stage fills every downstream still job', async () => {
  await reset();
  const out = await shoot();
  const ran = await ServerRunner.tick({ workerId: 'srv-test' });

  assert.strictEqual(ran.stage, 'prompt');
  assert.strictEqual(ran.status, 'done');
  assert.strictEqual(ran.result.assembled, 3);

  const { rows } = await pool.query(
    "SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'still' ORDER BY id",
    [out.project.id]
  );
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.ok(r.payload.generation, 'every still must carry a generation block');
    assert.ok(r.payload.generation.prompt.length > 50);
    assert.ok(r.payload.workflow, 'and the ComfyUI graph, so the job can move between runners');
  }
});

test('the identity block reaches every frame verbatim, in position two', async () => {
  await reset();
  const out = await shoot();
  await ServerRunner.tick({ workerId: 'srv-test' });

  const { rows } = await pool.query(
    "SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'still' ORDER BY id",
    [out.project.id]
  );
  for (const r of rows) {
    assert.ok(
      r.payload.generation.prompt.startsWith(
        'p4tk9x, 26 year old North Indian woman, warm medium-brown skin'
      ),
      'the trigger and identity must lead every prompt or the face drifts'
    );
  }
});

test('🐛 frames of one post get different seeds, or the carousel looks cloned', async () => {
  await reset();
  const out = await shoot();
  await ServerRunner.tick({ workerId: 'srv-test' });

  const { rows } = await pool.query(
    "SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'still' ORDER BY id",
    [out.project.id]
  );
  const seeds = rows.map((r) => r.payload.generation.seed);
  assert.strictEqual(new Set(seeds).size, 3, `seeds repeated: ${seeds.join(', ')}`);
});

test('seeds are derived, not random — a retry reproduces the same frames', () => {
  // Random seeds would mean "regenerate frame 3" silently changed frames 1, 2
  // and 4 as well, since the whole prompt stage re-runs.
  assert.strictEqual(PromptStage.seedFor(10, 20, 0), PromptStage.seedFor(10, 20, 0));
  assert.notStrictEqual(PromptStage.seedFor(10, 20, 0), PromptStage.seedFor(10, 21, 0));
});

test('🐛 a blended expression reaches the model, rather than waiting for a pass nobody built', async () => {
  // This asserted the opposite, and it was pinning a bug rather than a design.
  //
  // "crying" carries follow_on_pass: 'tears_inpaint', and that was read as a
  // reason not to prompt it — "the tears pass comes later". There is no tears
  // pass. Nothing reads follow_on_pass, blend_with, blend_ratio, base_emotion
  // or default_intensity, and there is no inpaint stage in STAGES. So the
  // picker offered Crying and the shoot rendered a calm face, and calibration
  // then measured that calm face and filed it under `crying` — teaching the QC
  // gate to reject real crying frames as the wrong person. Migration 053.
  await reset();
  const out = await shoot({
    shots: [{ framing: 'medium', expression_key: 'crying' }], frameCount: 1,
  });
  await ServerRunner.tick({ workerId: 'srv-test' });

  const { rows } = await pool.query(
    "SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'still'", [out.project.id]
  );
  const prompt = rows[0].payload.generation.prompt;
  assert.ok(prompt.includes('crying'), 'the frame asks for the expression it is labelled with');
  assert.ok(!prompt.includes('relaxed neutral expression'));
});

test('a shot asking for an expression nobody seeded fails the stage, rather than rendering calm', async () => {
  await reset();
  const out = await shoot({
    shots: [{ framing: 'medium', expression_key: 'smouldering' }], frameCount: 1,
  });
  await ServerRunner.tick({ workerId: 'srv-test' });

  const { rows } = await pool.query(
    "SELECT status, error FROM render_jobs WHERE project_id = $1 AND stage = 'prompt'", [out.project.id]
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error, /vocabulary/i,
    'the picker offered an option the vocabulary does not define — a configuration error, '
    + 'and a loud one, where the old `|| neutral` fallback made it invisible');
});

test('qc jobs are told which baseline to judge against', async () => {
  await reset();
  const out = await shoot();
  await ServerRunner.tick({ workerId: 'srv-test' });

  const { rows } = await pool.query(
    "SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'qc' ORDER BY id",
    [out.project.id]
  );
  // Re-deriving the expression in the QC stage would give two sources of truth
  // for what the frame was supposed to be.
  assert.deepStrictEqual(rows.map((r) => r.payload.preset_key), ['neutral', 'laughing', 'neutral']);
  assert.deepStrictEqual(rows.map((r) => r.payload.framing), ['close', 'medium', 'wide']);
  for (const r of rows) assert.strictEqual(r.payload.lora_id, LORA);
});

test('stills unlock only after the prompt stage lands', async () => {
  await reset();
  await shoot();
  assert.strictEqual(
    await RenderJob.claimNext({ runner: 'cloud', stages: ['still'], workerId: 'w' }), null
  );
  await ServerRunner.tick({ workerId: 'srv-test' });
  const still = await RenderJob.claimNext({ runner: 'cloud', stages: ['still'], workerId: 'w' });
  assert.ok(still && still.payload.generation, 'a still must never be claimable without its prompt');
});

test('a deactivated LoRA fails the stage permanently and blocks the rest', async () => {
  await reset();
  const out = await shoot();
  // createShoot checked this, but a model can be deactivated while the job waits.
  await pool.query('UPDATE avatar_loras SET active = FALSE WHERE id = $1', [LORA]);
  try {
    const ran = await ServerRunner.tick({ workerId: 'srv-test' });
    assert.strictEqual(ran.status, 'failed');

    const { rows } = await pool.query(
      'SELECT stage, status FROM render_jobs WHERE project_id = $1', [out.project.id]
    );
    const blocked = rows.filter((r) => r.status === 'blocked');
    assert.ok(blocked.length >= 6, 'nine jobs must not sit queued behind a parent that will never finish');
  } finally {
    await pool.query('UPDATE avatar_loras SET active = TRUE WHERE id = $1', [LORA]);
  }
});

test('drain returns to idle rather than spinning', async () => {
  await reset();
  await shoot();
  assert.strictEqual(await ServerRunner.drain({ workerId: 'srv-test' }), 1);
  assert.strictEqual(await ServerRunner.drain({ workerId: 'srv-test' }), 0);
});

// ── Calibration ───────────────────────────────────────────────────────────────

const samples = (n, drift) => Array.from({ length: n }, (_, i) => ({
  faces: 1, embedding: embedding(i + 1, drift),
}));

test('the plan shows the frame count and cost before any of it is spent', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  const plan = await Calibration.plan(TENANT, LORA);
  assert.ok(plan.cells.length > 10, 'expected a cell per preset per framing');
  assert.strictEqual(plan.total_frames, plan.cells.length * 6);
  assert.ok(plan.estimated_cost_cents > 100, '~200 frames is a real number the operator should see first');
});

test('a cell already measured drops out of the plan', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  const before = await Calibration.plan(TENANT, LORA);
  await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: samples(6, 0.05),
  });
  const after = await Calibration.plan(TENANT, LORA);
  assert.strictEqual(after.cells.length, before.cells.length - 1);
});

test('🐛 low-scoring frames are NOT dropped — the spread is the measurement', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  // Dropping the worst frames would make the sample tighter than reality, which
  // makes the tolerance smaller, which makes the gate reject normal output
  // forever. Only structurally broken frames are excluded.
  const mixed = [...samples(4, 0.05), ...samples(3, 0.9)];
  const tight = samples(7, 0.05);

  const wide = await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'close', samples: mixed,
  });
  const narrow = await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'wide', samples: tight,
  });

  assert.strictEqual(wide.used, 7, 'every usable frame must count, including the low ones');
  assert.ok(
    Number(wide.baseline.tolerance) > Number(narrow.baseline.tolerance),
    'a noisier expression must get a wider tolerance, not a filtered sample'
  );
});

test('a structurally broken frame is skipped and named', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  const withBroken = [
    ...samples(5, 0.05),
    { faces: 0, embedding: null },
    { faces: 2, embedding: embedding(9, 0.1) },
  ];
  const out = await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: withBroken,
  });
  assert.strictEqual(out.used, 5);
  assert.deepStrictEqual(out.skipped.map((s) => s.reason), ['no_face', 'multiple_faces']);
});

test('too few usable frames is refused rather than calibrated on noise', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  await assert.rejects(
    () => Calibration.recordCell({
      tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: samples(3, 0.05),
    }),
    (e) => e.code === 'NOT_ENOUGH_SAMPLES'
  );
});

test('an emotional expression gets a lower expectation than neutral, not a rejection', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  const neutral = await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: samples(6, 0.05),
  });
  const laughing = await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'laughing', framing: 'medium', samples: samples(6, 0.55),
  });
  // This is the entire reason the gate is per-expression. A single threshold set
  // from neutral would silently eat every laughing frame.
  assert.ok(
    Number(laughing.baseline.expected_similarity) < Number(neutral.baseline.expected_similarity),
    'geometry genuinely moves; the expectation must move with it'
  );
});

test('readiness will not call a model ready on neutral alone', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: samples(6, 0.05),
  });
  const state = await Calibration.readiness(TENANT, LORA);
  assert.strictEqual(state.ready, false);
  assert.ok(state.missing.length > 0, 'the emotional presets are the ones a global threshold would eat');
  // This used to assert the opposite — that `crying` is NOT required, because a
  // blended preset was "generated neutral and refined later". The refining pass
  // does not exist, so that made the picker offer an expression it could not
  // produce and calibration file a neutral face under its name. Migration 053.
  assert.ok(state.missing.includes('crying'),
    'crying is prompted like any other expression, so it has a baseline of its own to measure');
});

test('finish refuses an incomplete calibration and activates a complete one', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  await pool.query('UPDATE avatar_loras SET active = FALSE WHERE id = $1', [LORA]);

  await assert.rejects(() => Calibration.finish(TENANT, LORA), (e) => e.code === 'NOT_CALIBRATED');

  const state = await Calibration.readiness(TENANT, LORA);
  // Asked of the one shared answer rather than re-deriving it here — this query
  // was a fourth copy of "which presets count", and it disagreed with the other
  // three.
  const presets = await Calibration.expressible(TENANT);
  for (const p of presets) {
    await Calibration.recordCell({
      tenantId: TENANT, loraId: LORA, presetKey: p.key, framing: 'medium', samples: samples(6, 0.05),
    });
  }

  const done = await Calibration.finish(TENANT, LORA);
  assert.strictEqual(done.lora.active, true);
  assert.strictEqual(done.ready, true);
  assert.ok(state.missing.length > 0);
});

test('the calibrated gate passes a normal frame and fails a stranger', async () => {
  await pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);
  await Calibration.recordCell({
    tenantId: TENANT, loraId: LORA, presetKey: 'neutral', framing: 'medium', samples: samples(8, 0.05),
  });

  const ok = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'neutral', framing: 'medium',
    embedding: embedding(99, 0.05), referenceEmbedding: REFERENCE, detections: { faceCount: 1 },
  });
  assert.strictEqual(ok.pass, true);
  assert.strictEqual(ok.calibrated, true);
  assert.strictEqual(ok.baselineSource, 'exact');

  const stranger = await FaceQc.evaluate({
    avatarId: AVATAR, loraId: LORA, presetKey: 'neutral', framing: 'medium',
    embedding: embedding(99, 6.0), referenceEmbedding: REFERENCE, detections: { faceCount: 1 },
  });
  assert.strictEqual(stranger.pass, false);
  assert.strictEqual(stranger.reason, FaceQc.REJECT.BELOW_BASELINE);
});
