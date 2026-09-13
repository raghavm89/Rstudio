'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool         = require('../../src/config/db');
const Orchestrator = require('../../src/services/studio/orchestrator');
const PromptStage  = require('../../src/services/studio/promptStage');

/**
 * A character shoot, end to end through prompt assembly (the CA7/CA8 wiring).
 *
 * A character has a STYLE profile, not a look profile — so the orchestrator must
 * let it start (its precondition checked a look profile), and the prompt stage
 * must build the character prompt (style facets, no human photography). No
 * images: this stops at the assembled prompt on the still jobs' payloads, which
 * is exactly where the person prompt stage is testable too.
 */

let TENANT, AVATAR;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('character-shoot-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  for (const tbl of ['render_jobs', 'studio_projects', 'studio_usage_counters', 'avatars']) {
    await pool.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [TENANT]);
  }

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, subject_type, status, identity_block, lora_trigger)
     VALUES ($1,'mango','Mango','synthetic','character','active','a cheerful anthropomorphic mango','mang0') RETURNING id`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;
  await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'mango.safetensors','mang0','flux1-dev.safetensors',TRUE)`, [AVATAR]
  );
  // A character has a STYLE profile, not a look profile.
  await pool.query(`INSERT INTO style_profiles (avatar_id) VALUES ($1)`, [AVATAR]);
  await pool.query(
    `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
     VALUES (NULL,'credits',100000,'month')
     ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`
  );
});

test.after(async () => {
  for (const tbl of ['render_jobs', 'studio_projects', 'studio_usage_counters', 'avatars']) {
    await pool.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [TENANT]);
  }
  await pool.query(`UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`);
  await pool.end();
});

test('the orchestrator lets a character shoot start on its style profile', async () => {
  // Before the fix this threw "no look profile yet" — a character never has one.
  const out = await Orchestrator.createShoot({
    tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 2, tier: 'paid',
  });
  assert.ok(out.project && out.project.id, 'the shoot was created');
  assert.strictEqual(out.shots.length, 2);
});

test('the prompt stage builds a character prompt from the style profile', async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);

  const out = await Orchestrator.createShoot({
    tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 2, tier: 'paid',
  });

  const { rows: [promptJob] } = await pool.query(
    `SELECT * FROM render_jobs WHERE project_id = $1 AND stage = 'prompt'`, [out.project.id]
  );
  assert.ok(promptJob, 'a prompt job exists');
  await PromptStage.execute(promptJob);

  const { rows: stills } = await pool.query(
    `SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'still' ORDER BY id`, [out.project.id]
  );
  assert.ok(stills.length >= 1);
  for (const s of stills) {
    const prompt = s.payload?.generation?.prompt;
    assert.ok(prompt, 'the still job got an assembled prompt');
    assert.ok(prompt.includes('a cheerful anthropomorphic mango'), 'the character identity is in the prompt');
    assert.ok(/flat 2D vector illustration/.test(prompt), 'the render style (from the style profile) is applied');
    assert.ok(!/skin|pores|85mm|lens/.test(prompt), 'no human photography facets in a character prompt');
  }
});
