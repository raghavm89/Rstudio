'use strict';

/**
 * Deterministic prompt assembly + ComfyUI workflow construction.
 *
 * This module contains NO model calls. That is the point: the identity block is
 * concatenated verbatim, in a fixed position, on every single generation, and
 * nothing creative is ever allowed near it. Drift in the face is drift in this
 * file, and this file does not drift.
 *
 * The creator never types prompt language — they pick options, and the mapping
 * from option to fragment lives in the versioned `prompt_vocabulary` table.
 * Improving a fragment there improves every tenant's output with no action from
 * them, which a free-text prompt box would give away permanently.
 *
 * Subtraction is structural: there is no row in the vocabulary emitting
 * "flawless skin" or "porcelain complexion", so no combination of picker choices
 * can produce them. See migrations/030_studio_seed.sql.
 */

const fs = require('fs');
const path = require('path');

/**
 * Two templates, because the loaders differ by hardware.
 *
 * `cuda` uses UNETLoader with fp8, which is the fast path on NVIDIA.
 * `mps` uses UnetLoaderGGUF, because **fp8 does not work on Apple Silicon** —
 * PyTorch has no float8 kernels for Metal, so ComfyUI's fp8 path is CUDA-only
 * and an fp8 checkpoint either errors or silently produces noise. GGUF stores
 * quantised and dequantises to bf16 on the fly, which MPS does support.
 *
 * Everything between the loaders and SaveImage is identical, so a prompt built
 * for one backend renders the same on the other.
 */
const TEMPLATES = {
  cuda: path.join(__dirname, 'flux-lora-portrait.api.json'),
  mps:  path.join(__dirname, 'flux-lora-portrait-mac.api.json'),
};

// Node ids in flux-lora-portrait.api.json. Named so a graph edit is a one-line
// change here rather than a hunt through string literals.
const NODE = {
  UNET: '12',
  LORA: '40',
  MODEL_SAMPLING: '30',
  PROMPT: '6',
  GUIDANCE: '26',
  SCHEDULER: '17',
  NOISE: '25',
  LATENT: '5',
  SAVE: '9',
};

/** Order is load-bearing. Identity sits at position 2 and never moves. */
const PROMPT_ORDER = [
  'trigger',
  'identity',
  'wardrobe',
  'location',
  'pose',
  'expression',
  'camera',
  'light',
  'grade',
  'skin',
  'asymmetry',
  'hair',
  'framing',
  'quality',
];

// A character's prompt keeps the shared shot facets (expression, light, framing)
// but replaces the human LOOK block (camera/lens, grade, skin, asymmetry, hair)
// with one STYLE block from its style profile.
const CHARACTER_PROMPT_ORDER = [
  'trigger',
  'identity',
  'wardrobe',
  'location',
  'pose',
  'expression',
  'style',
  'light',
  'framing',
  'quality',
];

/**
 * Free-tier generations bill as 1 MP; paid as 2 MP and are upscaled server-side.
 *
 * fal bills FLUX-with-LoRA per megapixel ROUNDED UP, so the free tier must stay
 * strictly under 1,000,000 pixels or it silently costs the same as paid and the
 * whole cheap-free-tier argument evaporates. 896x1152 is 1.03 MP and rounds to
 * 2 — an easy and expensive mistake, caught by the test below.
 *
 * Both are 4:5 (Instagram's tallest feed crop) and divisible by 16, which Flux
 * requires.
 */
const DIMENSIONS = {
  '1mp': { width: 880, height: 1104 },   // 0.97 MP — bills as 1 MP
  '2mp': { width: 1024, height: 1280 },  // 1.31 MP — bills as 2 MP
};

class WorkflowError extends Error {}

/**
 * Turn the vocabulary rows into a lookup: facet -> option_key -> fragment.
 * Pass the rows straight from `SELECT facet, option_key, fragment FROM
 * prompt_vocabulary WHERE version = $1 AND active`.
 */
function indexVocabulary(rows) {
  const byFacet = Object.create(null);
  for (const row of rows) {
    if (!byFacet[row.facet]) byFacet[row.facet] = Object.create(null);
    byFacet[row.facet][row.option_key] = row.fragment;
  }
  return byFacet;
}

function fragment(vocab, facet, key, { required = false } = {}) {
  if (key === null || key === undefined || key === '') return '';
  const found = vocab[facet] && vocab[facet][key];
  if (found === undefined) {
    if (required) {
      throw new WorkflowError(
        `No vocabulary entry for ${facet}.${key} — the picker offered an option ` +
        `the vocabulary does not define. Seed it before shipping the option.`
      );
    }
    return '';
  }
  return found;
}

/**
 * The advanced field appends only. It can never replace or reorder the identity
 * block, the look profile or the quality tail — a power user can add something,
 * they cannot break their own face. Newlines and separators are stripped so it
 * cannot fake a new section.
 */
function sanitiseAppend(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[{}[\]<>|]/g, '')
    .trim()
    .slice(0, 240);
}

/** Merge light direction, quality and time of day into one lighting phrase. */
function lightingPhrase(vocab, shot, scene) {
  return [
    fragment(vocab, 'light_quality', shot.light_quality),
    fragment(vocab, 'light_direction', shot.light_direction, { required: true }),
    fragment(vocab, 'time_of_day', scene && scene.time_of_day),
  ].filter(Boolean).join(', ');
}

/**
 * Assemble the positive prompt.
 *
 * On Flux dev there is no negative prompt — the model is guidance-distilled and
 * effectively ignores one. That is why `avoid_block` is not sent here. It works
 * by absence instead: the vocabulary never emits the phrases we want to avoid.
 * Keep `avoid_block` on the avatar for providers that do honour negatives.
 */
function assemblePrompt({ avatar, lora, lookProfile, shot, scene, vocabulary, locationText, wardrobeText }) {
  if (!avatar || !avatar.identity_block || !avatar.identity_block.trim()) {
    throw new WorkflowError('avatar.identity_block is empty — refusing to generate a faceless persona.');
  }
  if (!lora || !lora.trigger_token) {
    throw new WorkflowError('No active LoRA for this avatar — train one before generating.');
  }
  if (!lookProfile) {
    throw new WorkflowError('No look profile — it is frozen at persona setup and required for every generation.');
  }

  const vocab = indexVocabulary(vocabulary);

  const parts = {
    trigger:    lora.trigger_token,
    identity:   avatar.identity_block.trim().replace(/\s+/g, ' '),
    wardrobe:   wardrobeText || '',
    location:   locationText || '',
    pose:       shot.pose_key || '',
    expression: fragment(vocab, 'expression', shot.expression_key || 'neutral', { required: true }),
    camera:     [
      fragment(vocab, 'base_look', lookProfile.base_look, { required: true }),
      fragment(vocab, 'lens', lookProfile.lens, { required: true }),
    ].filter(Boolean).join(', '),
    light:      lightingPhrase(vocab, shot, scene),
    grade:      [
      fragment(vocab, 'colour', lookProfile.colour),
      fragment(vocab, 'grain', lookProfile.grain),
    ].filter(Boolean).join(', '),
    skin:       fragment(vocab, 'skin', lookProfile.skin, { required: true }),
    asymmetry:  fragment(vocab, 'asymmetry', lookProfile.natural_asymmetry ? 'on' : 'off'),
    hair:       fragment(vocab, 'hair_detail', lookProfile.hair_detail ? 'on' : 'off'),
    framing:    fragment(vocab, 'framing', shot.framing, { required: true }),
    quality:    fragment(vocab, 'quality', 'base'),
  };

  const assembled = PROMPT_ORDER
    .map((k) => parts[k])
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');

  const append = sanitiseAppend(shot.advanced_append);
  return append ? `${assembled}, ${append}` : assembled;
}

/**
 * Assemble the positive prompt for a CHARACTER (non-human) avatar.
 *
 * Same spine as `assemblePrompt` — identity block, LoRA trigger, shared shot
 * facets, a quality tail — but the human look facets (lens, skin, grain,
 * asymmetry, hair) do not exist for a personified fruit, so they are replaced by
 * the style profile's illustration facets (render_style, palette, line_weight,
 * shading, background). `skin`/`lens` are never required here; `render_style`
 * and `framing` are.
 */
function assembleCharacterPrompt({ avatar, lora, styleProfile, shot, scene, vocabulary, locationText, wardrobeText }) {
  if (!avatar || !avatar.identity_block || !avatar.identity_block.trim()) {
    throw new WorkflowError('avatar.identity_block is empty — refusing to generate a characterless persona.');
  }
  if (!lora || !lora.trigger_token) {
    throw new WorkflowError('No active LoRA for this avatar — train one before generating.');
  }
  if (!styleProfile) {
    throw new WorkflowError('No style profile — it is frozen at setup and required for every generation.');
  }

  const vocab = indexVocabulary(vocabulary);

  const parts = {
    trigger:    lora.trigger_token,
    identity:   avatar.identity_block.trim().replace(/\s+/g, ' '),
    wardrobe:   wardrobeText || '',
    location:   locationText || '',
    pose:       shot.pose_key || '',
    expression: fragment(vocab, 'expression', shot.expression_key || 'neutral'),
    style:      [
      fragment(vocab, 'render_style', styleProfile.render_style, { required: true }),
      fragment(vocab, 'palette', styleProfile.palette),
      fragment(vocab, 'line_weight', styleProfile.line_weight),
      fragment(vocab, 'shading', styleProfile.shading),
      fragment(vocab, 'background', styleProfile.background),
    ].filter(Boolean).join(', '),
    light:      lightingPhrase(vocab, shot, scene),
    framing:    fragment(vocab, 'framing', shot.framing, { required: true }),
    quality:    fragment(vocab, 'quality', 'base'),
  };

  const assembled = CHARACTER_PROMPT_ORDER
    .map((k) => parts[k])
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');

  const append = sanitiseAppend(shot.advanced_append);
  return append ? `${assembled}, ${append}` : assembled;
}

/**
 * Which expressions the prompt can actually produce.
 *
 * This used to be a hardcoded object in this file, and being the one prompt
 * facet that lived in code is why it drifted out of step with the preset table
 * and stayed that way: it could express five of eleven presets while the picker
 * offered all eleven, and the other six rendered a neutral face under an
 * emotional label. Migration 053 is the whole story.
 *
 * So the answer is DERIVED from the vocabulary rather than declared anywhere.
 * A preset is expressible when there is a fragment for it — which means adding
 * a preset and forgetting its fragment cannot quietly produce neutral frames
 * filed under the new name. It fails at assembly instead, because the lookup
 * above is `required`.
 *
 * Callers pass the vocabulary ROWS, the same array `buildWorkflow` takes, so
 * nothing has to know how the index is built.
 */
function expressiblePresets(vocabulary, presets) {
  const vocab = indexVocabulary(vocabulary);
  const have = vocab.expression || {};
  return presets.filter((p) => typeof have[p.key] === 'string' && have[p.key].trim() !== '');
}

/**
 * Build the ComfyUI API-format workflow.
 *
 * Returns { workflow, prompt, seed, width, height, megapixels } — the caller
 * writes `prompt` and `megapixels` onto the asset row so cost is attributable
 * per generation rather than estimated later.
 */
function buildWorkflow(input) {
  const {
    avatar, lora, lookProfile, shot, scene, vocabulary,
    locationText, wardrobeText,
    seed, quality = '2mp', steps = 24, guidance = 3.5,
    loraStrength = 0.95, filenamePrefix, backend = 'cuda',
  } = input;

  const templatePath = TEMPLATES[backend];
  if (!templatePath) {
    throw new WorkflowError(`Unknown backend "${backend}" — expected one of ${Object.keys(TEMPLATES).join(', ')}.`);
  }

  const prompt = assemblePrompt({
    avatar, lora, lookProfile, shot, scene, vocabulary, locationText, wardrobeText,
  });

  const dims = DIMENSIONS[quality];
  if (!dims) throw new WorkflowError(`Unknown quality "${quality}" — expected one of ${Object.keys(DIMENSIONS).join(', ')}.`);

  // Never reuse a seed across frames in one post, or the carousel looks cloned.
  const noiseSeed = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 31);

  const wf = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  delete wf._comment;

  wf[NODE.LORA].inputs.lora_name = lora.file_path;
  wf[NODE.LORA].inputs.strength_model = loraStrength;

  wf[NODE.PROMPT].inputs.text = prompt;
  wf[NODE.GUIDANCE].inputs.guidance = guidance;
  wf[NODE.SCHEDULER].inputs.steps = steps;
  wf[NODE.NOISE].inputs.noise_seed = noiseSeed;

  wf[NODE.LATENT].inputs.width = dims.width;
  wf[NODE.LATENT].inputs.height = dims.height;
  wf[NODE.MODEL_SAMPLING].inputs.width = dims.width;
  wf[NODE.MODEL_SAMPLING].inputs.height = dims.height;

  // The GGUF loader takes a .gguf; the CUDA loader takes a .safetensors. A LoRA
  // row records which base it was trained against, so honour it only when it
  // matches the backend's expected extension rather than handing GGUF a
  // safetensors name and getting an unhelpful "file not found".
  if (lora.base_checkpoint) {
    const wantsGguf = backend === 'mps';
    const isGguf = /\.gguf$/i.test(lora.base_checkpoint);
    if (wantsGguf === isGguf) wf[NODE.UNET].inputs.unet_name = lora.base_checkpoint;
  }
  wf[NODE.SAVE].inputs.filename_prefix = filenamePrefix || `studio/${avatar.slug}/${noiseSeed}`;

  return {
    workflow: wf,
    prompt,
    seed: noiseSeed,
    width: dims.width,
    height: dims.height,
    megapixels: Math.ceil((dims.width * dims.height) / 1_000_000),
  };
}

module.exports = {
  buildWorkflow,
  assemblePrompt,
  assembleCharacterPrompt,
  expressiblePresets,
  indexVocabulary,
  sanitiseAppend,
  WorkflowError,
  DIMENSIONS,
  PROMPT_ORDER,
  CHARACTER_PROMPT_ORDER,
};
