'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Local storage so createStorage().readUrl(key) resolves without S3 config.
process.env.STUDIO_STORAGE = process.env.STUDIO_STORAGE || 'local';

const { recordStillAndFeedMotion } = require('../src/services/studio/shootAssets');

/** A fake pg client that records writes and answers the motion lookup. */
function fakeClient({ motionRow } = {}) {
  const calls = { assetInserts: [], motionUpdates: [], motionSelects: 0 };
  return {
    calls,
    async query(sql, params) {
      if (/INSERT INTO studio_assets/.test(sql)) { calls.assetInserts.push(params); return { rows: [] }; }
      if (/FROM render_jobs\s+WHERE project_id.*stage = 'motion'/s.test(sql)) {
        calls.motionSelects += 1;
        return { rows: motionRow ? [motionRow] : [] };
      }
      if (/UPDATE render_jobs/.test(sql)) { calls.motionUpdates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

const existing = {
  tenant_id: 1, project_id: 10, shot_id: 20,
  payload: { avatar_id: 2, lora_id: 3, generation: { prompt: 'a portrait', width: 880, height: 1104 } },
};
const done = { id: 5, tenant_id: 1, project_id: 10, cost_cents: 8, megapixels: 1 };

test('records one studio_asset per candidate frame, as pending and unselected', async () => {
  const c = fakeClient({ motionRow: { id: 99, payload: { generation: { motion_prompt: 'push in' } } } });
  const out = await recordStillAndFeedMotion(c, {
    existing, done,
    result: { assets: [{ key: 'k1' }, { key: 'k2' }], seed: 42, provider: 'fal', model: 'flux' },
  });
  assert.strictEqual(out.assets, 2, 'two frames recorded');
  assert.strictEqual(c.calls.assetInserts.length, 2);
  // candidate_index is param 15 (0-based 14) in the INSERT
  assert.strictEqual(c.calls.assetInserts[0][14], 0);
  assert.strictEqual(c.calls.assetInserts[1][14], 1);
});

test('feeds the FIRST frame to this shot\'s motion job without clobbering motion_prompt', async () => {
  const c = fakeClient({ motionRow: { id: 99, payload: { generation: { motion_prompt: 'push in' } } } });
  const out = await recordStillAndFeedMotion(c, {
    existing, done,
    result: { assets: [{ key: 'k1' }, { key: 'k2' }], seed: 42, provider: 'fal' },
  });
  assert.strictEqual(out.motionFed, true);
  assert.strictEqual(c.calls.motionSelects, 1);
  assert.strictEqual(c.calls.motionUpdates.length, 1);
  const gen = JSON.parse(c.calls.motionUpdates[0][1]);
  assert.ok(gen.image_url, 'motion got an image_url');
  assert.match(gen.image_url, /k1/, 'it is the first frame, not the second');
  assert.strictEqual(gen.motion_prompt, 'push in', 'the derived motion_prompt is preserved');
});

test('a photo post (no motion job) records assets and is a no-op for motion', async () => {
  const c = fakeClient({ motionRow: null });
  const out = await recordStillAndFeedMotion(c, {
    existing, done, result: { assets: [{ key: 'only' }], seed: 1, provider: 'fal' },
  });
  assert.strictEqual(out.assets, 1);
  assert.strictEqual(out.motionFed, false);
  assert.strictEqual(c.calls.motionUpdates.length, 0);
});

test('no asset means nothing recorded and motion left unfed', async () => {
  const c = fakeClient({ motionRow: { id: 99, payload: {} } });
  const out = await recordStillAndFeedMotion(c, { existing, done, result: { assets: [] } });
  assert.strictEqual(out.assets, 0);
  assert.strictEqual(out.motionFed, false);
});
