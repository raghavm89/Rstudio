'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool = require('../../src/config/db');
const ContentTemplate = require('../../src/services/studio/contentTemplate');

/**
 * Content templates — the ad / viral recipe library and applying it to an avatar.
 *
 * A template is a saved shoot recipe; applying one IS a `createShoot`, so the
 * substance is: the library lists platform + own (and never another tenant's
 * private one), the category↔kind rule holds, and an applied template produces a
 * real shoot whose shots are the recipe's shots.
 */

let TENANT_A, TENANT_B, AVATAR;

async function tenant(name) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`, [name]);
  return rows[0].id;
}

test.before(async () => {
  TENANT_A = await tenant('template-tenant-a');
  TENANT_B = await tenant('template-tenant-b');
  for (const T of [TENANT_A, TENANT_B]) {
    for (const tbl of ['render_jobs', 'studio_projects', 'studio_usage_counters', 'avatars']) {
      await pool.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [T]);
    }
    await pool.query(`DELETE FROM content_templates WHERE tenant_id = $1`, [T]);
  }
  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, lora_trigger)
     VALUES ($1,'ava','Ava','synthetic','active','a 26 year old woman','av4') RETURNING id`, [TENANT_A]);
  AVATAR = a.rows[0].id;
  await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'ava.safetensors','av4','flux1-dev.safetensors',TRUE)`, [AVATAR]);
  await pool.query(`INSERT INTO look_profiles (avatar_id) VALUES ($1)`, [AVATAR]);
  await pool.query(
    `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
     VALUES (NULL,'credits',100000,'month')
     ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`);
});

test.after(async () => {
  for (const T of [TENANT_A, TENANT_B]) {
    for (const tbl of ['render_jobs', 'studio_projects', 'studio_usage_counters', 'avatars']) {
      await pool.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [T]);
    }
    await pool.query(`DELETE FROM content_templates WHERE tenant_id = $1`, [T]);
  }
  await pool.query(`UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`);
  await pool.end();
});

test('the migration seeded a starter platform library across all three categories', async () => {
  const list = await ContentTemplate.list(pool, TENANT_A);
  const platform = list.filter((t) => t.is_platform);
  assert.ok(platform.length >= 3, 'at least the three seeded templates are visible to everyone');
  const cats = new Set(platform.map((t) => t.category));
  for (const c of ['ad_video', 'viral_video', 'viral_stills']) {
    assert.ok(cats.has(c), `the library covers ${c}`);
  }
});

test('the category filter and the category↔kind rule are enforced', async () => {
  const stills = await ContentTemplate.list(pool, TENANT_A, { category: 'viral_stills' });
  assert.ok(stills.every((t) => t.category === 'viral_stills'), 'the filter narrows to one category');

  await assert.rejects(
    () => ContentTemplate.create(pool, { tenantId: TENANT_A, name: 'Bad', category: 'ad_video', kind: 'post', recipe: {} }),
    (e) => e.code === 'BAD_KIND',
    'an ad video cannot be a post'
  );
});

test('applying a platform template makes a real shoot with the recipe’s shots', async () => {
  const [grwm] = (await ContentTemplate.list(pool, TENANT_A, { category: 'viral_video' })).filter((t) => t.is_platform);
  assert.ok(grwm, 'a viral-video platform template exists');

  const out = await ContentTemplate.apply({ tenantId: TENANT_A, avatarId: AVATAR, templateId: grwm.id, tier: 'free' });
  assert.ok(out.project && out.project.id, 'a shoot was created');
  assert.strictEqual(out.project.kind, grwm.kind);
  assert.strictEqual(out.shots.length, grwm.frame_count, 'one shot per recipe frame');

  // The shots are the recipe's shots — expression and framing carried through.
  const { rows: shots } = await pool.query(
    `SELECT s.seq, s.framing, s.expression_key
       FROM studio_shots s JOIN studio_scenes sc ON sc.id = s.scene_id
      WHERE sc.project_id = $1 ORDER BY s.seq`, [out.project.id]);
  const full = await ContentTemplate.get(pool, TENANT_A, grwm.id);
  assert.deepStrictEqual(
    shots.map((s) => s.expression_key),
    full.recipe.shots.map((s) => s.expression_key),
    'the shoot reproduces the template’s expression plan'
  );
});

test('a tenant cannot see or apply another tenant’s private template', async () => {
  const mine = await ContentTemplate.create(pool, {
    tenantId: TENANT_A, name: 'My Private Reel', category: 'viral_video', kind: 'reel',
    recipe: { shots: [{ framing: 'close', expression_key: 'soft_smile' }, { framing: 'medium', expression_key: 'laughing' }] },
  });
  assert.strictEqual(mine.is_platform, false);

  assert.strictEqual(await ContentTemplate.get(pool, TENANT_B, mine.id), null, 'B cannot fetch A’s private template');
  await assert.rejects(
    () => ContentTemplate.apply({ tenantId: TENANT_B, avatarId: AVATAR, templateId: mine.id, tier: 'free' }),
    (e) => e.status === 404,
    'B cannot apply A’s private template'
  );
});

test('a shoot can be saved back as a template, and an admin can publish it', async () => {
  // Make a shoot, then template it.
  const out = await ContentTemplate.apply({
    tenantId: TENANT_A, avatarId: AVATAR,
    templateId: (await ContentTemplate.list(pool, TENANT_A, { category: 'viral_stills' })).find((t) => t.is_platform).id,
    tier: 'free',
  });
  const saved = await ContentTemplate.saveFromShoot(pool, {
    tenantId: TENANT_A, projectId: out.project.id, name: 'My Saved Dump', category: 'viral_stills',
  });
  assert.strictEqual(saved.tenant_id, TENANT_A);
  assert.strictEqual(saved.is_platform, false);
  assert.strictEqual(saved.recipe.shots.length, out.shots.length, 'the saved recipe captured the shoot’s shots');

  // Admin promotes it to the shared library; now B can see it.
  await ContentTemplate.publish(pool, saved.id);
  const seenByB = await ContentTemplate.get(pool, TENANT_B, saved.id);
  assert.ok(seenByB && seenByB.is_platform, 'a published template is visible to every tenant');

  // A tenant may delete its OWN template but not a platform one.
  await assert.rejects(
    () => ContentTemplate.remove(pool, TENANT_B, saved.id),
    (e) => e.status === 404, 'B cannot delete a template it does not own'
  );
});
