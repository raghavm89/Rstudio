'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pool = require('../../src/config/db');
const LookProfile = require('../../src/services/studio/lookProfile');

let TENANT, AVATAR, LORA;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('studio-look-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block, lora_trigger)
     VALUES ($1,'look-avatar','Look Avatar','synthetic','draft',
             '26 year old North Indian woman, warm medium-brown skin, oval face, defined jawline, dark brown almond eyes',
             'extra fingers, plastic skin','l00ktk1') RETURNING id`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;

  const l = await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'x.safetensors','l00ktk1','flux1-dev.safetensors',TRUE) RETURNING id`,
    [AVATAR]
  );
  LORA = l.rows[0].id;
});

test.after(async () => {
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

const unfreeze = () => pool.query('DELETE FROM expression_baselines WHERE lora_id = $1', [LORA]);

// ── The screen's data ─────────────────────────────────────────────────────────

test('every option has a human label, including the one that emits nothing', async () => {
  await unfreeze();
  const d = await LookProfile.describe(TENANT, AVATAR);
  for (const facet of ['base_look', 'lens', 'colour', 'grain', 'skin']) {
    assert.ok(d.options[facet]?.length >= 2, `no options offered for ${facet}`);
    for (const o of d.options[facet]) {
      // `grain: none` legitimately emits no prompt text. Labelling options with
      // their fragment would have rendered it as a blank choice — and would have
      // shown the others as prompt engineering rather than English.
      assert.ok(o.label && o.label.length > 1, `${facet}.${o.key} has no label`);
      assert.ok(!/f\/\d|lens,|grade,/.test(o.label), `${facet}.${o.key} label is prompt text: ${o.label}`);
    }
  }
  const none = d.options.grain.find((o) => o.key === 'none');
  assert.strictEqual(none.label, 'None');
  assert.strictEqual(none.fragment, null, 'an empty fragment should be null, not an empty string');
});

test('the controls carry the notes that explain their constraints', async () => {
  const d = await LookProfile.describe(TENANT, AVATAR);
  const lens = d.facets.find((f) => f.key === 'lens');
  assert.match(lens.note, /nothing wider than 35mm/);
  const skin = d.facets.find((f) => f.key === 'skin');
  assert.match(skin.note, /pores/);
});

test('the never-sent list is real — none of it exists in the vocabulary', async () => {
  // This is the claim the dark panel makes to a buyer. If any of these phrases
  // were reachable from a picker, the panel would be lying.
  const { rows } = await pool.query('SELECT fragment FROM prompt_vocabulary WHERE active');
  const all = rows.map((r) => r.fragment).join(' ').toLowerCase();
  for (const phrase of LookProfile.NEVER_SENT) {
    assert.ok(!all.includes(phrase.toLowerCase()), `"${phrase}" IS reachable — the panel would be false`);
  }
});

test('the preview assembles a real prompt, identity first', async () => {
  await unfreeze();
  await LookProfile.update(TENANT, AVATAR, {
    base_look: 'editorial', lens: 'portrait_85', colour: 'warm',
    grain: 'fine', skin: 'natural', natural_asymmetry: true, hair_detail: true,
  });
  const d = await LookProfile.describe(TENANT, AVATAR);
  assert.ok(d.preview.prompt.startsWith('l00ktk1, 26 year old North Indian woman'));
  assert.ok(d.preview.prompt.includes('visible skin pores'));
  assert.strictEqual(d.preview.trained, true);
});

test('a look can be previewed BEFORE a model exists', async () => {
  // The look has to be choosable before training, but assemblePrompt refuses
  // without a LoRA — correctly, since the product must never render a faceless
  // persona. A placeholder trigger stands in, and `trained: false` lets the
  // screen say so rather than implying a model exists.
  await unfreeze();
  await pool.query('UPDATE avatar_loras SET active = FALSE WHERE id = $1', [LORA]);
  try {
    const d = await LookProfile.describe(TENANT, AVATAR);
    assert.strictEqual(d.preview.trained, false);
    assert.ok(d.preview.prompt.startsWith('TRIGGER, 26 year old'));
  } finally {
    await pool.query('UPDATE avatar_loras SET active = TRUE WHERE id = $1', [LORA]);
  }
});

// ── Saving ────────────────────────────────────────────────────────────────────

test('an option the vocabulary does not define is refused at save time', async () => {
  await unfreeze();
  await assert.rejects(
    () => LookProfile.update(TENANT, AVATAR, { lens: 'fisheye_12' }),
    (e) => e.status === 400 && e.code === 'UNKNOWN_OPTION'
  );
});

test('toggles are coerced, not trusted', async () => {
  await unfreeze();
  const d = await LookProfile.update(TENANT, AVATAR, { natural_asymmetry: 'yes', hair_detail: 0 });
  assert.strictEqual(d.profile.natural_asymmetry, true);
  assert.strictEqual(d.profile.hair_detail, false);
  await LookProfile.update(TENANT, AVATAR, { hair_detail: true });
});

test('changing the look changes the assembled prompt', async () => {
  await unfreeze();
  const warm = await LookProfile.update(TENANT, AVATAR, { colour: 'warm', skin: 'natural' });
  const cool = await LookProfile.update(TENANT, AVATAR, { colour: 'cool' });
  assert.notStrictEqual(warm.preview.prompt, cool.preview.prompt);
  await LookProfile.update(TENANT, AVATAR, { colour: 'warm' });
});

// ── The freeze ────────────────────────────────────────────────────────────────

test('🔒 the look locks once QC baselines exist', async () => {
  // The gate measures a frame against an expectation calibrated on faces
  // generated under THESE settings. Change the lens afterwards and every frame
  // is judged against a face rendered a different way — the numbers drift with
  // nothing reporting an error, which is the worst kind of wrong.
  await unfreeze();
  assert.strictEqual(await LookProfile.isFrozen(AVATAR), false);

  await pool.query(
    `INSERT INTO expression_baselines (avatar_id, lora_id, preset_key, framing, expected_similarity)
     VALUES ($1,$2,'neutral','medium',0.84)`,
    [AVATAR, LORA]
  );

  assert.strictEqual(await LookProfile.isFrozen(AVATAR), true);
  await assert.rejects(
    () => LookProfile.update(TENANT, AVATAR, { colour: 'cool' }),
    (e) => e.status === 409 && e.code === 'LOOK_FROZEN'
  );

  // And the screen is told, so it can disable the pickers rather than letting
  // someone click into a refusal.
  const d = await LookProfile.describe(TENANT, AVATAR);
  assert.strictEqual(d.frozen, true);
  await unfreeze();
});

test('another tenant cannot read or change this look', async () => {
  await assert.rejects(() => LookProfile.describe(TENANT + 99999, AVATAR), (e) => e.status === 404);
  await assert.rejects(
    () => LookProfile.update(TENANT + 99999, AVATAR, { colour: 'cool' }),
    (e) => e.status === 404
  );
});
