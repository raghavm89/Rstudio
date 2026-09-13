'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const C = require('../../src/services/studio/seedPromptCharacter');

/**
 * The character seed planner (Phase C, CA8).
 *
 * Same coverage-grid contract as the person planner, but a character's
 * vocabulary: pose/prop/scene vary per frame, style facets stay, and no human
 * photography facet ever appears.
 */

const AVATAR = { identity_block: 'a cheerful anthropomorphic mango with little arms and legs' };
const STYLE  = { render_style: 'flat_2d', palette: 'warm', line_weight: 'bold', shading: 'soft', background: 'plain' };
const VOCAB  = {
  render_style: { flat_2d: 'flat 2D vector illustration' },
  palette:      { warm: 'warm palette' },
  line_weight:  { bold: 'bold outlines' },
  shading:      { soft: 'soft shading' },
  framing:      { close: 'close-up', medium: 'medium shot', full: 'full body' },
  light_quality:{ soft: 'soft light', hard: 'hard light' },
  light_direction: { camera_left: 'lit from camera left', camera_right: 'lit from camera right', window: 'window light', flat: 'flat light' },
  quality:      { base: 'high quality illustration' },
  // Deliberately NO skin/lens/grain — a character has none.
};

const seq = () => { let n = 0; return () => ((n = (n + 1) % 100) / 100); };

test('a batch plans N frames, each with a cell, prompt, seed and label', () => {
  const frames = C.plan({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 20, random: seq() });
  assert.strictEqual(frames.length, 20);
  for (const f of frames) {
    assert.ok(f.cell && f.prompt && f.label);
    assert.ok(Number.isInteger(f.seed) && f.seed < 2 ** 31);
  }
});

test('the prompt is built from style facets, with no human photography leaking in', () => {
  const [f] = C.plan({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 1, random: seq() });
  assert.ok(f.prompt.startsWith('a cheerful anthropomorphic mango'), 'identity leads the prompt');
  assert.ok(f.prompt.includes('flat 2D vector illustration'), 'the render style is applied');
  assert.ok(f.prompt.includes('warm palette') && f.prompt.includes('bold outlines'), 'style facets are in');
  assert.ok(!/skin|pores|85mm|lens|grain/.test(f.prompt), 'no human look facets in a character prompt');
});

test('pose, prop and scene vary per frame so none is learned as identity', () => {
  const frames = C.plan({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 12, random: seq() });
  const poses  = new Set(frames.map((f) => C.DEFAULT_POSES.find((p) => f.prompt.includes(p))));
  const scenes = new Set(frames.map((f) => C.DEFAULT_SCENES.find((s) => f.prompt.includes(s))));
  assert.ok(poses.size >= 3, 'poses vary across the batch');
  assert.ok(scenes.size >= 2, 'scenes vary across the batch');
  // The style profile's background facet must NOT be applied — the scene owns
  // the background during seed training, exactly as location does for a person.
  assert.ok(!frames[0].prompt.includes('clean solid-colour background'),
    'the style background facet is excluded from seed frames');
});

test('the first frames cover every framing x angle x quality cell', () => {
  // 3 framings x 3 angles x 2 qualities = 18 gate cells. The nesting puts these
  // innermost, so the first 18 consecutive frames span all of them.
  const frames = C.plan({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 18, random: seq() });
  const gateCells = new Set(frames.map((f) => C.cellKey(f.cell)));
  assert.strictEqual(gateCells.size, 18, 'a short batch already spans every export-gate cell');
});

test('anchors are drawn from identity alone: one legible cell, plain ground, no prop', () => {
  const anchors = C.planAnchors({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 6, random: seq() });
  assert.strictEqual(anchors.length, 6);
  for (const a of anchors) {
    assert.strictEqual(a.cell.framing, 'close');
    assert.strictEqual(a.cell.angle, 'front');
    assert.ok(a.prompt.includes('a plain neutral background'), 'a plain ground so only the character differs');
    assert.ok(!C.DEFAULT_PROPS.some((p) => a.prompt.includes(p)), 'no prop on an anchor frame');
  }
  assert.strictEqual(C.planAnchors({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 99 }).length, C.ANCHOR_MAX);
  assert.strictEqual(C.planAnchors({ avatar: AVATAR, style: STYLE, vocab: VOCAB, count: 1 }).length, C.ANCHOR_MIN);
});

// ── The starter taxonomy ─────────────────────────────────────────────────────

test('the taxonomy offers real archetypes and personalities', () => {
  assert.ok(C.ARCHETYPES.length >= 5 && C.ARCHETYPES.every((a) => a.key && a.label && a.hint));
  assert.ok(C.PERSONALITIES.includes('cheerful'));
});

test('composeIdentity fills the archetype, and carries no pose/prop/scene', () => {
  const id = C.composeIdentity({ archetype: 'fruit', subject: 'mango', personality: 'cheerful' });
  assert.ok(/cheerful/.test(id) && /mango/.test(id), 'personality and subject are both in');
  assert.ok(!/holding|wearing|standing|sitting|park|street|background/i.test(id),
    'identity must never freeze a pose, prop or scene');
  // Unknown archetype falls back rather than throwing.
  const fallback = C.composeIdentity({ archetype: 'nonsense', subject: 'thing' });
  assert.ok(fallback.includes('thing'));
});
