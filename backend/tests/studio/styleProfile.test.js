'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool = require('../../src/config/db');
const StyleProfile = require('../../src/services/studio/styleProfile');
const { assembleCharacterPrompt, WorkflowError } =
  require('../../src/services/studio/comfyui/buildWorkflow');

/**
 * The style profile — a character's answer to the look profile (Phase C).
 *
 * A person's look is camera/lens/skin; a character's is an illustration style.
 * These hold the two halves: the assembler builds a character prompt from style
 * facets without ever needing a human facet, and the profile validates + freezes
 * the same way the look profile does.
 */

// A minimal vocabulary covering the facets a character prompt touches.
const VOCAB = [
  { facet: 'render_style', option_key: 'flat_2d', fragment: 'flat 2D vector illustration' },
  { facet: 'palette',      option_key: 'warm',    fragment: 'warm palette' },
  { facet: 'line_weight',  option_key: 'bold',    fragment: 'bold outlines' },
  { facet: 'shading',      option_key: 'soft',    fragment: 'soft shading' },
  { facet: 'background',   option_key: 'plain',   fragment: 'plain background' },
  { facet: 'expression',   option_key: 'neutral', fragment: 'calm expression' },
  { facet: 'framing',      option_key: 'medium',  fragment: 'medium shot' },
  { facet: 'light_quality',   option_key: 'soft',        fragment: 'soft light' },
  { facet: 'light_direction', option_key: 'camera_left', fragment: 'lit from camera left' },
  { facet: 'time_of_day',  option_key: 'afternoon', fragment: 'afternoon' },
  { facet: 'quality',      option_key: 'base',    fragment: 'high quality' },
];
const CHARACTER = { identity_block: 'a cheerful anthropomorphic mango' };
const LORA = { trigger_token: 'mang0' };
const STYLE = { render_style: 'flat_2d', palette: 'warm', line_weight: 'bold', shading: 'soft', background: 'plain' };
const SHOT = { framing: 'medium', expression_key: 'neutral', light_direction: 'camera_left', light_quality: 'soft' };

// ── The assembler (pure) ─────────────────────────────────────────────────────

test('a character prompt is built from style facets, not human look facets', () => {
  const prompt = assembleCharacterPrompt({
    avatar: CHARACTER, lora: LORA, styleProfile: STYLE, shot: SHOT,
    scene: { time_of_day: 'afternoon' }, vocabulary: VOCAB, locationText: '', wardrobeText: '',
  });
  assert.match(prompt, /^mang0, a cheerful anthropomorphic mango/, 'trigger then identity lead the prompt');
  assert.ok(prompt.includes('flat 2D vector illustration'), 'the render style is in');
  assert.ok(prompt.includes('warm palette') && prompt.includes('bold outlines'), 'the style block is in');
  assert.ok(prompt.includes('medium shot') && prompt.includes('lit from camera left'), 'shared shot facets stay');
  assert.ok(!/skin|pores|lens|85mm/.test(prompt), 'no human photography facets leak into a character');
});

test('render_style is required; a missing fragment refuses rather than drawing style-less', () => {
  const vocabNoStyle = VOCAB.filter((v) => v.facet !== 'render_style');
  assert.throws(
    () => assembleCharacterPrompt({
      avatar: CHARACTER, lora: LORA, styleProfile: STYLE, shot: SHOT,
      scene: {}, vocabulary: vocabNoStyle, locationText: '', wardrobeText: '',
    }),
    WorkflowError
  );
});

test('the advanced append is appended, not able to reorder the prompt', () => {
  const prompt = assembleCharacterPrompt({
    avatar: CHARACTER, lora: LORA, styleProfile: STYLE,
    shot: { ...SHOT, advanced_append: 'holding a tiny umbrella' },
    scene: {}, vocabulary: VOCAB, locationText: '', wardrobeText: '',
  });
  assert.ok(prompt.endsWith('holding a tiny umbrella'), 'append lands at the end');
});

test('a character with no identity block is refused, like a person with no face', () => {
  assert.throws(
    () => assembleCharacterPrompt({
      avatar: { identity_block: '' }, lora: LORA, styleProfile: STYLE, shot: SHOT,
      scene: {}, vocabulary: VOCAB, locationText: '', wardrobeText: '',
    }),
    WorkflowError
  );
});

// ── The profile (DB) ─────────────────────────────────────────────────────────

let TENANT, CHAR_AVATAR, PERSON_AVATAR;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('style-profile-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  // A character, set up the way the create controller sets one up: avatar + a
  // default style_profiles row.
  const c = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, subject_type, status, identity_block)
     VALUES ($1,'mango','Mango','synthetic','character','draft','a cheerful anthropomorphic mango') RETURNING id`,
    [TENANT]
  );
  CHAR_AVATAR = c.rows[0].id;
  await pool.query(`INSERT INTO style_profiles (avatar_id) VALUES ($1)`, [CHAR_AVATAR]);

  const pr = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, subject_type, status, identity_block)
     VALUES ($1,'a-person','A Person','synthetic','person','draft','a 26 year old woman') RETURNING id`,
    [TENANT]
  );
  PERSON_AVATAR = pr.rows[0].id;
});

test.after(async () => {
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

test('the migration seeded a real style vocabulary', async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT facet FROM prompt_vocabulary
      WHERE version = 1 AND facet IN ('render_style','palette','line_weight','shading','background')`
  );
  assert.strictEqual(rows.length, 5, 'all five style facets have vocabulary');
});

test('describe returns the style, its options and a rendered preview', async () => {
  const d = await StyleProfile.describe(TENANT, CHAR_AVATAR);
  assert.strictEqual(d.profile.render_style, 'flat_2d', 'the default style');
  assert.ok(d.options.render_style.length >= 5, 'every render style is offered');
  assert.ok(d.preview && d.preview.prompt && d.preview.prompt.includes('flat 2D vector illustration'),
    'the preview assembles a real prompt from the vocabulary');
  assert.ok(Array.isArray(d.never_sent) && d.never_sent.length, 'the anti-cheap-illustration list is shown');
});

test('the style screen refuses a person — that avatar has a look profile', async () => {
  await assert.rejects(
    () => StyleProfile.describe(TENANT, PERSON_AVATAR),
    (e) => e.code === 'NOT_A_CHARACTER'
  );
});

test('update validates against the vocabulary and rejects an unknown option', async () => {
  const after = await StyleProfile.update(TENANT, CHAR_AVATAR, { render_style: 'watercolour', palette: 'cool' });
  assert.strictEqual(after.profile.render_style, 'watercolour');
  assert.strictEqual(after.profile.palette, 'cool');

  await assert.rejects(
    () => StyleProfile.update(TENANT, CHAR_AVATAR, { render_style: 'crayon' }),
    (e) => e.code === 'UNKNOWN_OPTION'
  );
});
