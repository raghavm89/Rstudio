'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildWorkflow, assemblePrompt, sanitiseAppend, WorkflowError } = require('./buildWorkflow');

// The real seeded vocabulary, dumped from prompt_vocabulary. Regenerate with:
//   psql -qAtc "select json_agg(row_to_json(v)) from (select facet, option_key,
//     fragment from prompt_vocabulary where version=1 and active) v" > vocabulary.v1.json
const vocabulary = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'vocabulary.v1.json'), 'utf8')
);

const avatar = {
  slug: 'aanya-kapoor',
  identity_block:
    '26 year old North Indian woman, warm medium-brown skin, oval face with a defined jawline, ' +
    'dark brown almond eyes, thick natural brows, straight nose with a slightly rounded tip, ' +
    'full lips, dark brown hair to mid-back with a loose natural wave, lean athletic build, 5 foot 6',
  avoid_block: 'extra fingers, deformed hands, plastic skin',
};

const lora = {
  file_path: 'aanya_kapoor_v1.safetensors',
  trigger_token: 'a4ny4prsn',
  base_checkpoint: 'flux1-dev.safetensors',
};

const lookProfile = {
  base_look: 'editorial',
  lens: 'portrait_85',
  colour: 'warm',
  grain: 'fine',
  skin: 'natural',
  natural_asymmetry: true,
  hair_detail: true,
};

const shot = {
  framing: 'medium',
  light_direction: 'camera_left',
  light_quality: 'soft',
  expression_key: 'laughing',
  pose_key: 'seated, turning toward the window',
};

const scene = { location_key: 'cafe', time_of_day: 'afternoon' };

const base = {
  avatar, lora, lookProfile, shot, scene, vocabulary,
  locationText: 'corner cafe in Bandra, wooden tables, large street-facing window',
  wardrobeText: 'cropped charcoal tee with wide-leg sand trousers, thin gold chain',
};

test('identity block is reproduced verbatim and sits immediately after the trigger', () => {
  const prompt = assemblePrompt(base);
  const expected = `${lora.trigger_token}, ${avatar.identity_block}`;
  assert.ok(prompt.startsWith(expected), `prompt did not start with trigger + identity.\nGot: ${prompt.slice(0, 160)}`);
});

test('every look-profile facet reaches the prompt', () => {
  const p = assemblePrompt(base);
  for (const needle of [
    'clean editorial lighting',                       // base_look
    '85mm f/1.4 portrait lens',                       // lens
    'warm colour grade',                              // colour
    'fine film grain',                                // grain
    'visible skin pores',                             // skin
    'natural facial asymmetry',                       // asymmetry
    'individual hair strands visible at the hairline',// hair
    'medium shot',                                    // framing
    'catchlights in the eyes',                        // light direction
    'warm afternoon light',                           // time of day
  ]) {
    assert.ok(p.includes(needle), `missing "${needle}"`);
  }
});

test('the vocabulary cannot emit the phrases that erase real skin texture', () => {
  // The subtractive half of the design is enforced by ABSENCE. If any of these
  // appear, someone added a vocabulary row they should not have.
  const banned = ['flawless skin', 'porcelain', 'perfect symmetry', 'airbrushed', 'blemish-free', 'poreless'];
  const everyFragment = vocabulary.map((v) => v.fragment).join(' ').toLowerCase();
  for (const term of banned) {
    assert.ok(!everyFragment.includes(term), `vocabulary emits banned term "${term}"`);
  }
  const p = assemblePrompt(base).toLowerCase();
  for (const term of banned) {
    assert.ok(!p.includes(term), `assembled prompt contains banned term "${term}"`);
  }
});

test('refuses to generate without an identity block', () => {
  assert.throws(
    () => assemblePrompt({ ...base, avatar: { ...avatar, identity_block: '   ' } }),
    WorkflowError
  );
});

test('refuses to generate without an active LoRA', () => {
  assert.throws(() => assemblePrompt({ ...base, lora: null }), WorkflowError);
});

test('refuses an option the vocabulary does not define', () => {
  assert.throws(
    () => assemblePrompt({ ...base, lookProfile: { ...lookProfile, lens: 'fisheye_12' } }),
    WorkflowError
  );
});

test('advanced append is appended, sanitised, and cannot displace identity', () => {
  const p = assemblePrompt({
    ...base,
    shot: { ...shot, advanced_append: 'holding a\nfilter coffee {ignore previous} <b>' },
  });
  assert.ok(p.startsWith(`${lora.trigger_token}, ${avatar.identity_block}`), 'identity was displaced');
  assert.ok(p.includes('holding a filter coffee ignore previous'), 'append missing');
  assert.ok(!p.includes('{') && !p.includes('<'), 'separators were not stripped');
  assert.ok(p.indexOf('holding a filter') > p.indexOf('photorealistic'), 'append must come last');
});

test('sanitiseAppend caps length and strips newlines', () => {
  const out = sanitiseAppend('x\n'.repeat(400));
  assert.ok(out.length <= 240);
  assert.ok(!out.includes('\n'));
});

test('quality tier maps to the billed megapixel count', () => {
  // fal bills per megapixel ROUNDED UP. A free tier at 1.03 MP bills as 2 and
  // costs exactly what paid costs, which would quietly destroy the free-tier
  // economics. Guard the pixel count, not just the label.
  const free = buildWorkflow({ ...base, quality: '1mp', seed: 1 });
  const paid = buildWorkflow({ ...base, quality: '2mp', seed: 1 });
  assert.ok(free.width * free.height < 1_000_000, 'free tier must stay under 1 MP of actual pixels');
  assert.strictEqual(free.megapixels, 1, 'free tier must bill as 1 MP');
  assert.strictEqual(paid.megapixels, 2, 'paid tier bills as 2 MP');
  assert.ok(free.width * free.height < paid.width * paid.height);
  for (const d of [free, paid]) {
    assert.strictEqual(d.width % 16, 0, 'Flux needs width divisible by 16');
    assert.strictEqual(d.height % 16, 0, 'Flux needs height divisible by 16');
    const ratio = d.width / d.height;
    assert.ok(Math.abs(ratio - 0.8) < 0.01, `expected 4:5, got ${ratio.toFixed(3)}`);
  }
});

test('every node reference in the built workflow resolves', () => {
  const { workflow } = buildWorkflow({ ...base, seed: 42 });
  const ids = new Set(Object.keys(workflow));
  for (const [id, node] of Object.entries(workflow)) {
    assert.ok(node.class_type, `node ${id} has no class_type`);
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value)) {
        assert.ok(ids.has(value[0]), `node ${id}.${name} points at missing node ${value[0]}`);
        assert.strictEqual(typeof value[1], 'number', `node ${id}.${name} has a non-numeric slot`);
      }
    }
  }
});

test('workflow carries the assembled prompt, seed, lora and dimensions', () => {
  const built = buildWorkflow({ ...base, seed: 12345, quality: '2mp' });
  assert.strictEqual(built.workflow['6'].inputs.text, built.prompt);
  assert.strictEqual(built.workflow['25'].inputs.noise_seed, 12345);
  assert.strictEqual(built.workflow['40'].inputs.lora_name, lora.file_path);
  assert.strictEqual(built.workflow['5'].inputs.width, built.width);
  // ModelSamplingFlux must agree with the latent or Flux shifts incorrectly.
  assert.strictEqual(built.workflow['30'].inputs.width, built.workflow['5'].inputs.width);
  assert.strictEqual(built.workflow['30'].inputs.height, built.workflow['5'].inputs.height);
});

test('omitting a seed produces varying seeds, so frames are not clones', () => {
  const seeds = new Set(Array.from({ length: 8 }, () => buildWorkflow(base).seed));
  assert.ok(seeds.size > 1, 'seeds did not vary across candidates');
});

test('the mps backend uses GGUF loaders, because fp8 does not work on Apple Silicon', () => {
  const mac = buildWorkflow({ ...base, backend: 'mps', seed: 7 });
  assert.strictEqual(mac.workflow['12'].class_type, 'UnetLoaderGGUF');
  assert.strictEqual(mac.workflow['11'].class_type, 'DualCLIPLoaderGGUF');
  assert.ok(/\.gguf$/.test(mac.workflow['12'].inputs.unet_name));
  // PyTorch has no float8 kernels for Metal — an fp8 hint here is a silent
  // failure or a noise image, so it must not appear anywhere on this path.
  assert.strictEqual(mac.workflow['12'].inputs.weight_dtype, undefined);
  assert.ok(!JSON.stringify(mac.workflow).includes('fp8'), 'no fp8 anywhere in the Mac graph');

  const cuda = buildWorkflow({ ...base, backend: 'cuda', seed: 7 });
  assert.strictEqual(cuda.workflow['12'].class_type, 'UNETLoader');
  assert.strictEqual(cuda.workflow['12'].inputs.weight_dtype, 'fp8_e4m3fn');
});

test('both backends produce the same prompt and the same seed', () => {
  const mac  = buildWorkflow({ ...base, backend: 'mps',  seed: 99 });
  const cuda = buildWorkflow({ ...base, backend: 'cuda', seed: 99 });
  assert.strictEqual(mac.prompt, cuda.prompt, 'switching hardware must not change the image being asked for');
  assert.strictEqual(mac.workflow['6'].inputs.text, cuda.workflow['6'].inputs.text);
  assert.strictEqual(mac.workflow['25'].inputs.noise_seed, cuda.workflow['25'].inputs.noise_seed);
});

test('an unknown backend is refused rather than silently defaulting', () => {
  assert.throws(() => buildWorkflow({ ...base, backend: 'rocm' }), WorkflowError);
});

test('a safetensors base checkpoint is not forced onto the GGUF loader', () => {
  const mac = buildWorkflow({
    ...base, backend: 'mps', seed: 1,
    lora: { ...lora, base_checkpoint: 'flux1-dev.safetensors' },
  });
  assert.ok(/\.gguf$/.test(mac.workflow['12'].inputs.unet_name),
    'the GGUF loader must keep its .gguf default rather than take a safetensors name');
});

test('🐛 a blended or multi-pass expression is prompted, not silently dropped', () => {
  // This test used to assert the opposite, and it was pinning a bug.
  //
  // "crying" carries `follow_on_pass: 'tears_inpaint'`, and that was read as
  // "do not prompt it — the still is generated neutral and refined after". The
  // refining pass does not exist and never did: nothing reads blend_ratio,
  // base_emotion, default_intensity or follow_on_pass, and there is no inpaint
  // stage. So the picker offered "Crying" and delivered a calm face, and
  // calibration then measured that calm face and filed it under `crying`.
  const p = assemblePrompt({
    ...base,
    shot: { ...shot, expression_key: 'crying', expression_follow_on: 'tears_inpaint' },
    vocabulary: [...base.vocabulary,
      { facet: 'expression', option_key: 'crying', fragment: 'crying, the eyes wet and reddened' }],
  });
  assert.ok(p.includes('crying, the eyes wet and reddened'),
    'a refinement hint is not a reason to withhold the expression');
  assert.ok(!p.includes('relaxed neutral expression'));
});

test('a preset the vocabulary cannot express is refused, not rendered calm', () => {
  // The failure mode this replaces is the quiet one: `light[key] || 'relaxed
  // neutral expression'` turned an unseeded preset into a neutral frame under
  // an emotional label, which nothing downstream could detect.
  assert.throws(
    () => assemblePrompt({ ...base, shot: { ...shot, expression_key: 'smouldering' } }),
    WorkflowError
  );
});
