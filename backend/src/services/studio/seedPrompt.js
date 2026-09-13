'use strict';

/**
 * Building the candidate pool: which cells to shoot, and what to ask for.
 *
 * ── Why this is a module and not part of seed-set.js any more ───────────────
 * All of it lived inside a top-level IIFE in `studio/seed-set.js`, where an
 * HTTP request could not reach it. That was fine while the only way to make a
 * candidate pool was to have the repository, a GPU and a terminal — which is
 * to say, while the only user was the person who wrote it. A customer has none
 * of the three, so the same logic has to run server-side, and the two must not
 * be two copies.
 *
 * ── Why generation cannot reuse the normal still path ───────────────────────
 * `buildWorkflow.assemblePrompt` refuses without a LoRA, `FalProvider.runStill`
 * refuses without a LoRA, and `orchestrator.createShoot` refuses without a
 * LoRA. All three are right: for every other kind of render, a missing LoRA
 * means the wrong face. This step is the exception that creates the LoRA, so it
 * gets its own path rather than a hole punched in three guards.
 */

const { ANGLES, FRAMINGS, QUALITIES } = require('./seedCandidates');

/**
 * The coverage grid.
 *
 * A LoRA only holds in the conditions its training set saw. A pool that is 300
 * front-on medium shots in soft light produces a model that falls apart the
 * first time it is asked for a profile at golden hour — and it fails quietly,
 * as drift rather than an error. So variation is systematic rather than random.
 *
 * No `wide`: in a wide shot the face is roughly fifty pixels across at this
 * resolution, which is below what a LoRA can learn identity from. Such a frame
 * does not teach the model who someone is, it teaches it to render a blurry
 * face at that scale. Wide shots are still available when SHOOTING — the model
 * renders at any distance using identity learned from closer frames.
 */
const GRID = {
  framing:         FRAMINGS,
  angle:           ANGLES,
  light_direction: ['camera_left', 'camera_right', 'window', 'flat'],
  light_quality:   QUALITIES,
  expression:      ['relaxed neutral expression', 'a soft closed-mouth smile', 'a level, confident look'],
};

/**
 * Wardrobe and location.
 *
 * These vary per frame ON PURPOSE, and it is the opposite of the identity
 * block's rule. Identity must never contain clothing or a place, because those
 * would be frozen into every future image. The candidate pool must contain
 * many of both, because a model trained on one outfit in one room learns that
 * the outfit and the room are part of the person.
 */
const DEFAULT_WARDROBE = [
  'a plain crew-neck tee and straight-leg trousers',
  'a fitted technical top and dark athletic trousers',
  'an oversized open overshirt over a plain fitted top',
];

const DEFAULT_LOCATIONS = [
  'a small apartment balcony with potted plants, a low city skyline behind',
  'a plain neighbourhood gym, rubber flooring, mirrored wall, high windows',
  'a small cafe with wooden tables, exposed brick and a street-facing window',
  'a seafront promenade at first light, low concrete wall and palms',
  'a work desk with twin monitors, a pinboard and an anglepoise lamp',
];

const ANGLE_TEXT = {
  front: 'facing the camera directly',
  'three-quarter': 'turned three-quarters toward the camera',
  profile: 'in profile, looking away from the camera',
};

/** Every frame is 880x1104 — 0.97 MP, which bills as 1. */
const WIDTH = 880;
const HEIGHT = 1104;
const MEGAPIXELS_EACH = 1;

/**
 * The order the grid is walked.
 *
 * The nesting is the load-bearing part. The three axes the export gate checks —
 * framing, angle, light quality — are the INNERMOST loops, so any 24
 * consecutive candidates span every cell the gate asks about. Walk them
 * outermost instead and the first 24 frames are all close/front, the first 72
 * all close, and a batch that stops early covers nothing.
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

/**
 * Thinnest cells first.
 *
 * A second batch should fill the gaps in the first rather than starting the
 * walk again — otherwise topping up a pool that is short on profiles produces
 * more front-on frames. `have` is a count per gate cell of what already exists.
 *
 * The original read it off disk with readdirSync. Server-side it comes from a
 * GROUP BY, which is the same question asked of the place that now holds the
 * answer.
 */
function orderCells(have = new Map()) {
  return cells()
    .map((c, i) => ({ c, i, n: have.get(cellKey(c)) || 0 }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .map((x) => x.c);
}

/** Non-throwing vocabulary lookup: a missing fragment drops out of the prompt. */
const frag = (vocab, facet, key) => (vocab?.[facet] && vocab[facet][key]) || '';

/**
 * One candidate's prompt.
 *
 * Same order as `buildWorkflow.PROMPT_ORDER` — identity immediately after the
 * (here absent) trigger token — so a candidate reads the way a real render
 * will, and a face that survives culling is a face the shoot path can
 * reproduce.
 */
function buildPrompt({ avatar, look, vocab, cell, wardrobe, location }) {
  return [
    String(avatar.identity_block || '').replace(/\s+/g, ' ').trim(),
    ANGLE_TEXT[cell.angle],
    wardrobe,
    location,
    cell.expression,
    frag(vocab, 'base_look', look?.base_look),
    frag(vocab, 'lens', look?.lens),
    frag(vocab, 'light_quality', cell.quality),
    frag(vocab, 'light_direction', cell.dir_),
    frag(vocab, 'colour', look?.colour),
    frag(vocab, 'grain', look?.grain),
    frag(vocab, 'skin', look?.skin),
    frag(vocab, 'asymmetry', look?.natural_asymmetry ? 'on' : 'off'),
    frag(vocab, 'hair_detail', look?.hair_detail ? 'on' : 'off'),
    frag(vocab, 'framing', cell.framing),
    frag(vocab, 'quality', 'base'),
  ].filter(Boolean).join(', ');
}

/** `0001-medium-three-quarter-soft` — the axes, readable, in generation order. */
const labelFor = (index, cell) =>
  `${String(index).padStart(4, '0')}-${cell.framing}-${cell.angle}-${cell.quality}`;

/**
 * Plan a batch: N frames, each with its cell, prompt, seed and label.
 *
 * Pure. Everything it needs is passed in, so the same function serves the CLI
 * and the controller and can be tested without a database or a GPU.
 */
function plan({ avatar, look, vocab, count, startIndex = 1, have = new Map(), random = Math.random }) {
  const work = orderCells(have);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const cell = work[i % work.length];
    const wardrobe = DEFAULT_WARDROBE[i % DEFAULT_WARDROBE.length];
    // Divided by 3 so wardrobe and location do not advance in lockstep — 3 and
    // 5 are coprime, so the pair does not repeat until frame 15.
    const location = DEFAULT_LOCATIONS[Math.floor(i / 3) % DEFAULT_LOCATIONS.length];
    const index = startIndex + i;

    out.push({
      index,
      cell,
      label: labelFor(index, cell),
      // 2^31, not 2^53: fal echoes the seed back and a value past what JSON can
      // carry exactly comes back as a different number, which would make the
      // stored seed unable to reproduce its own image.
      seed: Math.floor(random() * 2 ** 31),
      prompt: buildPrompt({ avatar, look, vocab, cell, wardrobe, location }),
    });
  }
  return out;
}

/**
 * Plan the anchor frames.
 *
 * These are the independent draws — a handful of faces from the identity block
 * alone, all in the one cell where a face is most legible, differing only by
 * seed. The customer picks one and it becomes the face; every frame after that
 * is generated FROM it rather than alongside it.
 *
 * Deliberately no wardrobe, no location and no expression. Three reasons, and
 * the first is the one that matters:
 *
 *   1. This frame is about to be handed to a model as "this is the person".
 *      A busy room and a strong outfit are exactly the parts we do NOT want
 *      carried into three hundred later frames — the same reason the identity
 *      block refuses the word "wearing".
 *   2. Six faces are being compared to each other. Varying anything else makes
 *      that a comparison of photographs instead of a comparison of faces.
 *   3. They are cheap and they are the point of failure: if none of six looks
 *      like the person in the customer's head, the block is wrong, and that is
 *      worth discovering for six frames rather than for two hundred.
 */
const ANCHOR_CELL = { framing: 'close', angle: 'front', quality: 'soft', expression: 'neutral', dir_: 'front' };

const ANCHOR_MIN = 3;
const ANCHOR_MAX = 12;
const ANCHOR_DEFAULT = 6;

const clampAnchors = (n) =>
  Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, Math.floor(Number(n) || ANCHOR_DEFAULT)));

function planAnchors({ avatar, look, vocab, count = ANCHOR_DEFAULT, startIndex = 1, random = Math.random }) {
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
        avatar, look, vocab, cell: ANCHOR_CELL,
        // A plain ground, so what differs between six frames is the face.
        wardrobe: 'a plain unbranded top',
        location: 'a plain neutral background',
      }),
    });
  }
  return out;
}

module.exports = {
  GRID, DEFAULT_WARDROBE, DEFAULT_LOCATIONS, ANGLE_TEXT,
  WIDTH, HEIGHT, MEGAPIXELS_EACH,
  cells, cellKey, orderCells, frag, buildPrompt, labelFor, plan,
  planAnchors, clampAnchors, ANCHOR_CELL, ANCHOR_MIN, ANCHOR_MAX, ANCHOR_DEFAULT,
};
