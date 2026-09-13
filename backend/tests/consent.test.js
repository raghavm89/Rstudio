'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Consent = require('../src/services/studio/consent');

test('cosineSimilarity: identical is 1, orthogonal is 0', () => {
  assert.strictEqual(Math.round(Consent.cosineSimilarity([1, 0, 0], [1, 0, 0])), 1);
  assert.strictEqual(Consent.cosineSimilarity([1, 0], [0, 1]), 0);
});
test('isSamePerson gates on the threshold', () => {
  assert.strictEqual(Consent.isSamePerson(0.9, 0.55), true);
  assert.strictEqual(Consent.isSamePerson(0.4, 0.55), false);
});

function fakeDb(record) {
  const calls = { updates: [] };
  return { calls, async query(sql, params) {
    if (/SELECT \* FROM consent_records/.test(sql)) return { rows: record ? [record] : [] };
    if (/UPDATE consent_records/.test(sql)) { calls.updates.push(params); return { rows: [] }; }
    if (/INSERT INTO consent_records/.test(sql)) return { rows: [{ id: 7, tenant_id: params[0], subject_name: params[1], verified: false }] };
    if (/UPDATE avatars SET consent_record_id/.test(sql)) return { rows: [{ id: params[1] }] };
    return { rows: [] };
  } };
}

test('verify marks a same-person capture verified with its score', async () => {
  const db = fakeDb({ id: 7, tenant_id: 1, video_url: 'v', reference_asset_url: 'r' });
  const measure = async () => [0.2, 0.1, 0.3]; // both sides identical -> similarity 1
  const out = await Consent.verify(db, { recordId: 7, tenantId: 1, verifiedBy: 9 }, { measure });
  assert.strictEqual(out.verified, true);
  assert.ok(out.matchScore > 0.99);
  const upd = db.calls.updates[0];
  assert.strictEqual(upd[2], true, 'verified=true written');
});

test('verify records a mismatch as unverified, not an error', async () => {
  const db = fakeDb({ id: 7, tenant_id: 1, video_url: 'v', reference_asset_url: 'r' });
  let n = 0;
  const measure = async () => (n++ === 0 ? [1, 0, 0] : [0, 1, 0]); // orthogonal -> 0
  const out = await Consent.verify(db, { recordId: 7, tenantId: 1, verifiedBy: 9 }, { measure });
  assert.strictEqual(out.verified, false);
  assert.strictEqual(db.calls.updates[0][2], false);
});

test('verify 404s an unknown record and 409s one missing material', async () => {
  await assert.rejects(() => Consent.verify(fakeDb(null), { recordId: 1, tenantId: 1 }, { measure: async () => [1] }),
    (e) => e.status === 404);
  const noMat = fakeDb({ id: 7, tenant_id: 1, video_url: null, reference_asset_url: 'r' });
  await assert.rejects(() => Consent.verify(noMat, { recordId: 7, tenantId: 1 }, { measure: async () => [1] }),
    (e) => e.status === 409);
});

test('create inserts a record and links it to the avatar', async () => {
  const db = fakeDb(null);
  const rec = await Consent.create(db, { tenantId: 1, avatarId: 2, subjectName: 'Raghav', videoUrl: 'v', referenceAssetUrl: 'r' });
  assert.strictEqual(rec.id, 7);
  assert.strictEqual(rec.subject_name, 'Raghav');
});
