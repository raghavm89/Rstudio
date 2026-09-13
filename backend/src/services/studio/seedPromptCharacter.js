'use strict';

/**
 * Building a CHARACTER's candidate pool — the character's answer to
 * `seedPrompt.js`.
 *
 * Same job, same shape (a coverage grid walked into N prompts, each with a
 * cell, a seed and a label), so the seed pipeline (`seedBatch`) can call this or
 * the person planner symmetrically. What differs is the vocabulary a character
 * needs:
 *
 *   • A person varies WARDROBE and LOCATION per frame so the model does not bake
 *     one outfit or one room into the identity. A character varies POSE, PROP
 *     and SCENE for exactly the same reason — a mascot trained only sitting in
 *     one room learns that sitting and the room are part of it.
 *   • A person's look facets (lens, skin, grain) are style-consistency and are
 *     applied to every frame. A character's are the STYLE facets (render_style,
 *     palette, line_weight, shading). The style profile's `background` facet is
 *     deliberately NOT applied here — the per-frame SCENE varies the background
 *     instead, the way LOCATION does for a person.
 *
 * See claude/character-line-scope.md (Phase C, CA8). The vocabulary + the
 * archetype taxonomy below are a v1 — expand them as the catalogue grows.
 */

const { ANGLES, FRAMINGS, QUALITIES } = require('./seedCandidates');

/**
 * The coverage grid. Same axes and the same reason as the person grid: a LoRA
 * only holds in the conditions its training set saw, so variation is systematic.
 * A character has framing, angle and light like anything drawn does.
 */
const GRID = {
  framing:         FRAMINGS,
  angle:           ANGLES,
  light_direction: ['camera_left', 'camera_right', 'window', 'flat'],
  light_quality:   QUALITIES,
  expression:      ['a cheerful open expression', 'a calm neutral expression', 'a surprised, delighted expression'],
};

/**
 * Pose, prop and scene — varied per frame so none of the three is learned as
 * part of the character. The character analogue of the person's wardrobe +
 * location, split into three because a character ACTS (pose) and often carries
 * something (prop) as well as being somewhere (scene).
 */
const DEFAULT_POSES = [
  'standing and waving',
  'sitting cross-legged',
  'mid-jump with arms raised',
  'giving a big thumbs up',
  'leaning on one elbow, thinking',
];

const DEFAULT_PROPS = [
  'holding a small takeaway coffee cup',
  'wearing round sunglasses',
  'with a tiny backpack on',
  'holding a little umbrella',
];

const DEFAULT_SCENES = [
  'a sunny city street with soft background bokeh',
  'a cozy room strung with fairy lights',
  'a green park lawn with a picnic blanket',
  'a colourful night market with warm lights',
  'a clean pastel studio backdrop',
];

const ANGLE_TEXT = {
  front: 'facing the camera directly',
  'three-quarter': 'turned three-quarters toward the camera',
  profile: 'in profile, looking away from the camera',
};

/** Every frame is 880x1104 — 0.97 MP, which bills as 1. Same as the person path. */
const WIDTH = 880;
const HEIGHT = 1104;
const MEGAPIXELS_EACH = 1;

/**
 * ── The starter taxonomy ────────────────────────────────────────────────────
 * What a character can BE. The parametric equivalent of the face catalogue's
 * age/region facets — it guides writing the identity block and seeds the
 * catalogue. `{subject}` is filled with the specific thing (mango, red panda,
 * toaster). A v1 set; add archetypes as the catalogue grows.
 */
const ARCHETYPES = [
  { key: 'fruit',         label: 'Personified fruit',        hint: 'a friendly anthropomorphic {subject} with little arms and legs and an expressive face' },
  { key: 'vegetable',     label: 'Personified vegetable',    hint: 'a friendly anthropomorphic {subject} with little arms and legs and an expressive face' },
  { key: 'dessert',       label: 'Personified dessert/snack',hint: 'a cute anthropomorphic {subject} with a happy face and tiny limbs' },
  { key: 'animal_mascot', label: 'Animal mascot',            hint: 'a cute cartoon {subject} mascot standing upright, big friendly eyes' },
  { key: 'creature',      label: 'Original creature',        hint: 'an original cute creature, a rounded soft {subject}, big expressive eyes' },
  { key: 'object_mascot', label: 'Object mascot',            hint: 'a friendly anthropomorphic {subject} with a face and little limbs' },
];

const PERSONALITIES = ['cheerful', 'mischievous', 'sleepy', 'sassy', 'wise', 'energetic', 'shy', 'dramatic'];

/**
 * Suggest an identity block from the taxonomy. Deliberately carries NO pose,
 * prop or scene — those vary per frame and must never freeze into the identity,
 * the same rule the person identity block follows about clothing and place.
 */
function composeIdentity({ archetype, subject, personality } = {}) {
  const arch = ARCHETYPES.find((a) => a.key === archetype) || ARCHETYPES[0];
  const body = arch.hint.replace('{subject}', String(subject || 'character').trim());
  const trait = PERSONALITIES.includes(personality) ? `${personality}, ` : '';
  return `${trait}${body}`.replace(/\s+/g, ' ').trim();
}

/** Non-throwing vocabulary lookup: a missing fragment drops out of the prompt. */
const frag = (vocab, facet, key) => (vocab?.[facet] && vocab[facet][key]) || '';

/**
 * One candidate's prompt. Identity first (as the person path puts it right after
 * the absent trigger), then the per-frame variation, then the STYLE facets — but
 * not the style profile's `background`, because the SCENE varies that here.
 */
function buildPrompt({ avatar, style, vocab, cell, pose, prop, scene }) {
  return [
    String(avatar.identity_block || '').replace(/\s+/g, ' ').trim(),
    ANGLE_TEXT[cell.angle],
    pose,
    prop,
    scene,
    cell.expression,
    frag(vocab, 'render_style', style?.render_style),
    frag(vocab, 'palette', style?.palette),
    frag(vocab, 'line_weight', style?.line_weight),
    frag(vocab, 'shading', style?.shading),
    frag(vocab, 'light_quality', cell.quality),
    frag(vocab, 'light_direction', cell.dir_),
    frag(vocab, 'framing', cell.framing),
    frag(vocab, 'quality', 'base'),
  ].filter(Boolean).join(', ');
}

/**
 * The order the grid is walked — framing, angle, quality innermost, so any 24
 * consecutive candidates span every cell the export gate checks. Identical
 * nesting to the person planner on purpose.
 */
function cells() {
  const out = [];
  for (const expression of GRID.expression)
    for (const dir_ of GRID.light_direction)
      for (const framing of GRID.framing)
        for (const angle of GRID.angle)
          for (const quality of GRID.light_quality)
            out.push({ framing, angle, quality, dir_, expression });
  return out;
}

const cellKey = (c) => `${c.framing}|${c.angle}|${c.quality}`;

/** Thinnest cells first, so a top-up fills gaps rather than restarting the walk. */
function orderCells(have = new Map()) {
  return cells()
    .map((c, i) => ({ c, i, n: have.get(cellKey(c)) || 0 }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .map((x) => x.c);
}

const labelFor = (index, cell) =>
  `${String(index).padStart(4, '0')}-${cell.framing}-${cell.angle}-${cell.quality}`;

/**
 * Plan a batch: N frames, each with its cell, prompt, seed and label. Pure.
 *
 * Pose (5), prop (4) and scene are advanced out of lockstep — 5 and 4 are
 * coprime, and scene steps every four frames — so the trio does not repeat
 * early and the pool does not learn a pose/prop/scene as identity.
 */
function plan({ avatar, style, vocab, count, startIndex = 1, have = new Map(), random = Math.random }) {
  const work = orderCells(have);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const cell  = work[i % work.length];
    const pose  = DEFAULT_POSES[i % DEFAULT_POSES.length];
    const prop  = DEFAULT_PROPS[i % DEFAULT_PROPS.length];
    const scene = DEFAULT_SCENES[Math.floor(i / 4) % DEFAULT_SCENES.length];
    const index = startIndex + i;

    out.push({
      index,
      cell,
      label: labelFor(index, cell),
      seed: Math.floor(random() * 2 ** 31),
      prompt: buildPrompt({ avatar, style, vocab, cell, pose, prop, scene }),
    });
  }
  return out;
}

// Anchors — a handful of draws from the identity alone, one legible cell, no
// pose/prop/scene, so six frames are a comparison of the CHARACTER and nothing
// else. The customer picks one and every later frame is generated from it.
const ANCHOR_CELL = { framing: 'close', angle: 'front', quality: 'soft', expression: 'a calm neutral expression', dir_: 'front' };

const ANCHOR_MIN = 3;
const ANCHOR_MAX = 12;
const ANCHOR_DEFAULT = 6;

const clampAnchors = (n) =>
  Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, Math.floor(Number(n) || ANCHOR_DEFAULT)));

function planAnchors({ avatar, style, vocab, count = ANCHOR_DEFAULT, startIndex = 1, random = Math.random }) {
  const frames = clampAnchors(count);
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const index = startIndex + i;
    out.push({
      index,
      cell: ANCHOR_CELL,
      label: `a${labelFor(index, ANCHOR_CELL)}`,
      seed: Math.floor(random() * 2 ** 31),
      prompt: buildPrompt({
        avatar, style, vocab, cell: ANCHOR_CELL,
        pose: '', prop: '', scene: 'a plain neutral background',
      }),
    });
  }
  return out;
}

module.exports = {
  GRID, DEFAULT_POSES, DEFAULT_PROPS, DEFAULT_SCENES, ANGLE_TEXT,
  ARCHETYPES, PERSONALITIES, composeIdentity,
  WIDTH, HEIGHT, MEGAPIXELS_EACH,
  cells, cellKey, orderCells, frag, buildPrompt, labelFor, plan,
  planAnchors, clampAnchors, ANCHOR_CELL, ANCHOR_MIN, ANCHOR_MAX, ANCHOR_DEFAULT,
};
