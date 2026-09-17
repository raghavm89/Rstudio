'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runQc, selectBest, QcError } = require('../src/services/studio/qcStage');

test('selectBest picks the highest-similarity PASSING candidate', () => {
  assert.strictEqual(selectBest([
    { asset_id: 1, pass: true, similarity: 0.80 },
    { asset_id: 2, pass: true, similarity: 0.91 },
    { asset_id: 3, pass: false, similarity: 0.99 }, // rejected, ignored despite higher sim
  ]).asset_id, 2);
  assert.strictEqual(selectBest([{ asset_id: 1, pass: false, similarity: 0.9 }]), null);
  assert.strictEqual(selectBest([]), null);
});

/** A fake pg client answering QC's reads and recording its writes. */
function fakeDb({ candidates, motionRow }) {
  const calls = { verdictUpdates: [], selectClears: 0, selectSets: [], motionUpdates: [] };
  return {
    calls,
    async query(sql, params) {
      if (/FROM studio_assets\s+WHERE project_id.*kind = 'still'.*ORDER BY candidate_index/s.test(sql)) return { rows: candidates };
      if (/SET qc_status = \$2/.test(sql)) { calls.verdictUpdates.push(params); return { rows: [] }; }
      if (/SET selected = false WHERE shot_id/.test(sql)) { calls.selectClears += 1; return { rows: [] }; }
      if (/SET selected = true WHERE id = \$1/.test(sql)) { calls.selectSets.push(params[0]); return { rows: [] }; }
      if (/FROM render_jobs\s+WHERE project_id.*stage = 'motion'/s.test(sql)) return { rows: motionRow ? [motionRow] : [] };
      if (/UPDATE render_jobs/.test(sql)) { calls.motionUpdates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('img') });
const embedder = { embed: async () => ({ ok: true, embedding: [0.1, 0.2, 0.3], faces: 1 }) };
const job = { stage: 'qc', project_id: 10, shot_id: 20, payload: { avatar_id: 2, lora_id: 3, preset_key: 'neutral', framing: 'medium', expected_aspect: 0.8 } };

test('QC judges each candidate, selects the best pass, and feeds motion', async () => {
  const db = fakeDb({
    candidates: [{ id: 101, storage_url: 'u1', candidate_index: 0 }, { id: 102, storage_url: 'u2', candidate_index: 1 }],
    motionRow: { id: 99, payload: { generation: { motion_prompt: 'push in' } } },
  });
  // fake judge: frame 102 scores higher and passes, 101 passes lower
  const judge = async ({ embedding }) => ({ pass: true, reason: null, similarity: db.calls.verdictUpdates.length === 0 ? 0.72 : 0.88 });
  const out = await runQc(job, { db, embedder, judge, fetchImpl, reference: [0.1, 0.2, 0.3] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result.passed, 2);
  assert.strictEqual(out.result.selected, 102, 'the higher-similarity frame is selected');
  assert.strictEqual(db.calls.verdictUpdates.length, 2, 'both candidates got a verdict written');
  assert.strictEqual(db.calls.selectSets[0], 102);
  assert.strictEqual(out.result.motionFed, true);
  const gen = JSON.parse(db.calls.motionUpdates[0][1]);
  assert.strictEqual(gen.image_url, 'u2', 'motion re-pointed at the selected frame');
  assert.strictEqual(gen.motion_prompt, 'push in', 'motion_prompt preserved');
});

test('when nothing passes, QC fails permanently and does not feed motion', async () => {
  const db = fakeDb({
    candidates: [{ id: 101, storage_url: 'u1', candidate_index: 0 }],
    motionRow: { id: 99, payload: {} },
  });
  const judge = async () => ({ pass: false, reason: 'below_baseline', similarity: 0.41 });
  await assert.rejects(
    () => runQc(job, { db, embedder, judge, fetchImpl, reference: [0.1] }),
    (e) => e instanceof QcError && e.permanent === true && e.qcResult && e.qcResult.selected === null
  );
  assert.strictEqual(db.calls.motionUpdates.length, 0, 'motion was not fed a rejected frame');
});

test('a candidate with no stored url is rejected, not measured', async () => {
  const db = fakeDb({ candidates: [{ id: 101, storage_url: null, candidate_index: 0 }], motionRow: null });
  const judge = async () => ({ pass: true, similarity: 0.9 });
  await assert.rejects(() => runQc(job, { db, embedder, judge, fetchImpl, reference: [0.1] }),
    (e) => e.permanent === true); // the only candidate is urless -> no pass -> fail
});
