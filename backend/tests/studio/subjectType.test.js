'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const pool         = require('../../src/config/db');
const FaceQc       = require('../../src/services/studio/faceQc');
const Orchestrator = require('../../src/services/studio/orchestrator');

/**
 * The subject_type fork (Phase A).
 *
 * A `character` avatar depicts nobody and takes the non-human pipeline. Phase A
 * is the routing only: the column, the value flowing to the render jobs, and the
 * QC judgement skipping the face-only rejects that a face detector — which never
 * runs for a character — would otherwise use to auto-reject every frame.
 */

let TENANT, AVATAR;

test.before(async () => {
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ('subject-type-tenant')
     ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  TENANT = t.rows[0].id;
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);

  const a = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, subject_type, status, identity_block, lora_trigger)
     VALUES ($1,'mango','Mango','synthetic','character','active','a cheerful mango character','mang0') RETURNING id, subject_type`,
    [TENANT]
  );
  AVATAR = a.rows[0].id;
  assert.strictEqual(a.rows[0].subject_type, 'character', 'the column stores what it was given');
  await pool.query(
    `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active)
     VALUES ($1,1,'mango.safetensors','mang0','flux1-dev.safetensors',TRUE)`, [AVATAR]
  );
  await pool.query(`INSERT INTO style_profiles (avatar_id) VALUES ($1)`, [AVATAR]);  // a character has a style profile, not a look profile
  await pool.query(
    `INSERT INTO studio_entitlements (plan_id, metric, limit_value, period)
     VALUES (NULL,'credits',100000,'month')
     ON CONFLICT (metric, period) WHERE plan_id IS NULL DO UPDATE SET limit_value = EXCLUDED.limit_value`
  );
});

test.after(async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM avatars WHERE tenant_id = $1', [TENANT]);
  await pool.query(
    `UPDATE studio_entitlements SET limit_value = 40 WHERE plan_id IS NULL AND metric = 'credits'`
  );
  await pool.end();
});

// ── The column + its constraint ──────────────────────────────────────────────

test('subject_type defaults to person and rejects anything but the two values', async () => {
  const def = await pool.query(
    `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block)
     VALUES ($1,'a-person','A Person','synthetic','draft','x') RETURNING subject_type`, [TENANT]
  );
  assert.strictEqual(def.rows[0].subject_type, 'person', 'existing/omitted rows are people');
  await pool.query(`DELETE FROM avatars WHERE tenant_id = $1 AND slug = 'a-person'`, [TENANT]);

  await assert.rejects(
    () => pool.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, subject_type, status, identity_block)
       VALUES ($1,'bad','Bad','synthetic','alien','draft','x')`, [TENANT]),
    /avatars_subject_type_allowed|check constraint/i,
    'the CHECK constraint is the real gate, not just the app'
  );
});

// ── The QC judgement fork (pure routing, no images) ─────────────────────────

test('a character skips the face-only rejects; a person does not', async () => {
  const vec = [1, 0, 0, 0];   // identical embedding → cosine 1 → clears the 0.60 floor
  const noFace = { faceCount: 0 };

  const person = await FaceQc.evaluate({
    avatarId: 999999, loraId: 1, embedding: vec, referenceEmbedding: vec,
    detections: noFace, subjectType: 'person',
  });
  assert.strictEqual(person.pass, false);
  assert.strictEqual(person.reason, FaceQc.REJECT.NO_FACE, 'a person with no detected face is rejected');

  const character = await FaceQc.evaluate({
    avatarId: 999999, loraId: 1, embedding: vec, referenceEmbedding: vec,
    detections: noFace, subjectType: 'character',
  });
  assert.strictEqual(character.pass, true, 'a character is judged on similarity alone, not face count');
  assert.ok(character.similarity >= 0.6);

  // Two "faces" is a red flag for a person, meaningless for a character.
  const twoFaces = await FaceQc.evaluate({
    avatarId: 999999, loraId: 1, embedding: vec, referenceEmbedding: vec,
    detections: { faceCount: 2 }, subjectType: 'character',
  });
  assert.strictEqual(twoFaces.pass, true, 'multiple-faces does not apply to a character');
});

test('generic image-quality rejects still apply to a character', async () => {
  const vec = [1, 0, 0, 0];
  const textArtifact = await FaceQc.evaluate({
    avatarId: 999999, loraId: 1, embedding: vec, referenceEmbedding: vec,
    detections: { faceCount: 0, textArtifact: true }, subjectType: 'character',
  });
  assert.strictEqual(textArtifact.reason, FaceQc.REJECT.TEXT_ARTIFACT, 'garbled text is still garbled text');
});

test('the embedder is chosen by subject type', () => {
  assert.strictEqual(FaceQc.embedderFor('person'), 'insightface');
  assert.strictEqual(FaceQc.embedderFor('character'), 'clip');
  assert.strictEqual(FaceQc.embedderFor(undefined), 'insightface', 'unknown falls back to the person path');
});

// ── The value flows onto the render jobs ────────────────────────────────────

test('a character shoot carries subject_type onto every render job', async () => {
  await pool.query('DELETE FROM render_jobs WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_projects WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM studio_usage_counters WHERE tenant_id = $1', [TENANT]);

  const out = await Orchestrator.createShoot({
    tenantId: TENANT, avatarId: AVATAR, kind: 'post', frameCount: 2, tier: 'paid',
  });
  const { rows } = await pool.query(
    `SELECT payload FROM render_jobs WHERE project_id = $1`, [out.project.id]
  );
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.payload.subject_type === 'character'),
    'the QC stage reads this off the payload to know which pipeline it is in');
});
