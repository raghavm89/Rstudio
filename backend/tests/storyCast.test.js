'use strict';

const test = require('node:test');
const assert = require('node:assert');
const StoryCast = require('../src/services/studio/storyCast');

/**
 * Fake pg client for the cast resolver. It answers the one ANY($1) query with
 * whatever avatar rows the test declares, keyed by id, filtered to the ids asked
 * for (mirroring `WHERE a.id = ANY($1)`). No Postgres.
 */
function fakeDb(rowsById) {
  return {
    async query(sql, params) {
      if (/FROM avatars a/.test(sql)) {
        const ids = params[0];
        return { rows: ids.map((id) => rowsById[id]).filter(Boolean) };
      }
      return { rows: [] };
    },
  };
}

// A fully-usable persona (own, active lora, look profile, synthetic).
const persona = { id: 10, slug: 'aanya', name: 'Aanya', mode: 'synthetic', subject_type: 'person',
  character_source: 'template', voice_provider: 'indicf5', voice_id: 'ref-1', is_catalogue: false,
  lora_id: 100, has_look_profile: 10, has_style_profile: null, consent_verified: null, attestation_active: null, selected_by_tenant: null };
// A usable catalogue character (selected by the tenant, style profile, template origin).
const mascot = { id: 20, slug: 'mango', name: 'Mango', mode: 'synthetic', subject_type: 'character',
  character_source: 'template', voice_provider: 'sarvam', voice_id: 'bulbul', is_catalogue: true,
  lora_id: 200, has_look_profile: null, has_style_profile: 20, consent_verified: null, attestation_active: null, selected_by_tenant: 1 };

test('resolves a mixed cast (own persona + catalogue character)', async () => {
  const db = fakeDb({ 10: persona, 20: mascot });
  const { byKey, list } = await StoryCast.resolve(db, { tenantId: 1,
    members: [{ key: 'lead', avatarId: 10 }, { key: 'costar', avatarId: 20, role: 'subject' }] });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(byKey.get('lead').loraId, 100);
  assert.strictEqual(byKey.get('lead').subjectType, 'person');
  assert.strictEqual(byKey.get('costar').loraId, 200);
  assert.strictEqual(byKey.get('costar').subjectType, 'character');
  assert.strictEqual(byKey.get('costar').isCatalogue, true);
  assert.strictEqual(byKey.get('costar').voiceProvider, 'sarvam');
});

test('refuses a member with no trained model', async () => {
  const db = fakeDb({ 10: persona, 20: { ...mascot, lora_id: null } });
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 'a', avatarId: 10 }, { key: 'b', avatarId: 20 }] }),
    (e) => e.code === 'NO_LORA' && e.avatarId === 20);
});

test('refuses a character with no style profile', async () => {
  const db = fakeDb({ 20: { ...mascot, has_style_profile: null } });
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 'b', avatarId: 20 }] }),
    (e) => e.code === 'NO_PROFILE' && e.avatarId === 20);
});

test('refuses an avatar not owned and not catalogue-selected', async () => {
  const db = fakeDb({}); // query returns nothing → not visible to this tenant
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 'x', avatarId: 99 }] }),
    (e) => e.code === 'NO_AVATAR' && e.avatarId === 99);
});

test('refuses a twin without verified consent', async () => {
  const twin = { ...persona, id: 30, name: 'Twin', mode: 'twin', consent_verified: false };
  const db = fakeDb({ 30: twin });
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 't', avatarId: 30 }] }),
    (e) => e.code === 'CONSENT_REQUIRED' && e.avatarId === 30);
});

test('refuses an upload-origin character without an active attestation', async () => {
  const uploaded = { ...mascot, id: 40, name: 'Uploaded', character_source: 'upload', attestation_active: null };
  const db = fakeDb({ 40: uploaded });
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 'u', avatarId: 40 }] }),
    (e) => e.code === 'ATTESTATION_REQUIRED' && e.avatarId === 40);
});

test('rejects a duplicate cast key', async () => {
  const db = fakeDb({ 10: persona });
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [{ key: 'lead', avatarId: 10 }, { key: 'lead', avatarId: 10 }] }),
    (e) => e.code === 'DUP_KEY');
});

test('empty cast is refused', async () => {
  const db = fakeDb({});
  await assert.rejects(() => StoryCast.resolve(db, { tenantId: 1, members: [] }), (e) => e.code === 'NO_CAST');
});
