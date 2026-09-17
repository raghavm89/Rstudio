'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CA = require('../src/services/studio/characterAttestation');

/**
 * A fake pg client answering the attestation service's reads and recording its
 * writes — no Postgres, the same technique as qcStage.test.js.
 */
function fakeDb({ avatar = null, activeRec = null, linkedRec = null } = {}) {
  const calls = { inserts: [], avatarUpdates: [], attUpdates: [], loraUpdates: [], statusUpdates: [] };
  let nextId = 501;
  return {
    calls,
    async query(sql, params) {
      // loadCharacter
      if (/SELECT id, slug, name, subject_type, mode, character_source, attestation_id FROM avatars/.test(sql)) {
        return { rows: avatar ? [avatar] : [] };
      }
      // record INSERT
      if (/INSERT INTO character_attestations/.test(sql)) {
        const row = {
          id: nextId++, tenant_id: params[0], avatar_id: params[1], user_id: params[2],
          upload_ref: params[3], attestation_text_version: params[4], attested_text: params[5],
          ip: params[6], user_agent: params[7], active: true, source_hash: null, created_at: 'now',
        };
        calls.inserts.push(row);
        return { rows: [row] };
      }
      // record → link avatar
      if (/UPDATE avatars SET character_source = 'upload'/.test(sql)) { calls.avatarUpdates.push(params); return { rows: [] }; }
      // active()
      if (/FROM character_attestations ca\s+JOIN avatars a ON a\.attestation_id = ca\.id/.test(sql)) {
        return { rows: activeRec ? [activeRec] : [] };
      }
      // takedown: SELECT by id
      if (/SELECT \* FROM character_attestations WHERE id = \$1/.test(sql)) {
        return { rows: linkedRec ? [linkedRec] : [] };
      }
      // takedown: fallback linked record
      if (/SELECT ca\.\* FROM character_attestations ca JOIN avatars a ON a\.attestation_id = ca\.id WHERE a\.id/.test(sql)) {
        return { rows: linkedRec ? [linkedRec] : [] };
      }
      if (/UPDATE character_attestations\s+SET active = FALSE/.test(sql)) { calls.attUpdates.push(params); return { rows: [] }; }
      if (/UPDATE character_attestations\s+SET source_hash/.test(sql)) { calls.attUpdates.push(params); return { rows: [] }; }
      if (/UPDATE avatars SET status = 'retired'/.test(sql)) { calls.statusUpdates.push(params); return { rows: [] }; }
      if (/UPDATE avatar_loras SET active = FALSE/.test(sql)) { calls.loraUpdates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

const charAvatar = { id: 7, slug: 'mango', name: 'Mango', subject_type: 'character', mode: 'synthetic', character_source: 'template', attestation_id: null };

test('record: logs the attestation and marks the avatar upload-origin', async () => {
  const db = fakeDb({ avatar: charAvatar });
  const rec = await CA.record(db, { tenantId: 1, avatarId: 7, userId: 2, uploadRef: 'k/abc.png', attested: true });
  assert.strictEqual(db.calls.inserts.length, 1);
  assert.strictEqual(rec.avatar_id, 7);
  assert.strictEqual(rec.attestation_text_version, CA.ATTESTATION_TEXT_VERSION);
  assert.strictEqual(db.calls.avatarUpdates.length, 1, 'avatar linked to the record');
  assert.strictEqual(db.calls.avatarUpdates[0][0], rec.id);
});

test('record: refuses without the tick', async () => {
  const db = fakeDb({ avatar: charAvatar });
  await assert.rejects(() => CA.record(db, { tenantId: 1, avatarId: 7, attested: false }),
    (e) => e.code === 'NOT_ATTESTED');
  assert.strictEqual(db.calls.inserts.length, 0);
});

test('record: refuses a non-character avatar', async () => {
  const person = { ...charAvatar, subject_type: 'person' };
  const db = fakeDb({ avatar: person });
  await assert.rejects(() => CA.record(db, { tenantId: 1, avatarId: 7, attested: true }),
    (e) => e.code === 'NOT_A_CHARACTER');
});

test('requireActive: not gated for a person or a template character', async () => {
  const db = fakeDb({});
  // person
  await assert.doesNotReject(() => CA.requireActive(db, { id: 7, subject_type: 'person', character_source: 'template' }));
  // template-origin character
  await assert.doesNotReject(() => CA.requireActive(db, { id: 7, subject_type: 'character', character_source: 'template' }));
});

test('requireActive: throws for an upload character with no active attestation', async () => {
  const db = fakeDb({ activeRec: null });
  await assert.rejects(() => CA.requireActive(db, { id: 7, subject_type: 'character', character_source: 'upload' }),
    (e) => e.code === 'ATTESTATION_REQUIRED' && e.status === 403);
});

test('requireActive: passes when an active attestation exists', async () => {
  const rec = { id: 9, avatar_id: 7, active: true };
  const db = fakeDb({ activeRec: rec });
  const got = await CA.requireActive(db, { id: 7, subject_type: 'character', character_source: 'upload' });
  assert.strictEqual(got.id, 9);
});

test('takedown: deactivates the record, retires the avatar, pulls the model', async () => {
  const rec = { id: 9, avatar_id: 7, active: true };
  const db = fakeDb({ linkedRec: rec });
  const out = await CA.takedown(db, { attestationId: 9, by: 3, reason: 'trademark' });
  assert.strictEqual(out.avatarId, 7);
  assert.strictEqual(out.retired, true);
  assert.strictEqual(db.calls.attUpdates.length, 1, 'attestation deactivated');
  assert.strictEqual(db.calls.statusUpdates.length, 1, 'avatar retired');
  assert.strictEqual(db.calls.loraUpdates.length, 1, 'active LoRA pulled');
});

test('takedown: refuses when there is no record', async () => {
  const db = fakeDb({ linkedRec: null });
  await assert.rejects(() => CA.takedown(db, { attestationId: 999 }), (e) => e.code === 'NO_RECORD');
});
