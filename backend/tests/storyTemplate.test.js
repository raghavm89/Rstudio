'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/**
 * Story templates — the ready-to-go multi-character library.
 *
 * These exercise contentTemplate's story path WITHOUT Postgres by injecting a
 * fake db pool and a fake Orchestrator into the require cache before the module
 * loads, then driving apply/list against declared rows. What we prove:
 *   • listStories flags a story available only when its WHOLE cast is catalogued
 *   • applyStory resolves cast slugs → catalogue avatars, auto-selects them, and
 *     calls createShoot with the lead as avatarId and the co-stars as cast[]
 *   • a story whose cast is not fully catalogued refuses cleanly (CAST_NOT_READY)
 */

const dbPath = require.resolve('../src/config/db');
const orchPath = require.resolve('../src/services/studio/orchestrator');
const ctPath = require.resolve('../src/services/studio/contentTemplate');

// A programmable fake pool. `script` maps a matcher → handler(sql, params).
function makePool() {
  const calls = [];
  const pool = {
    handlers: [],
    on(matcher, fn) { this.handlers.push([matcher, fn]); return this; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [m, fn] of this.handlers) {
        if (m.test(sql)) return fn(sql, params);
      }
      return { rows: [] };
    },
    calls,
  };
  return pool;
}

const capturedShoots = [];
function installFakes(pool) {
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: { createShoot: async (args) => { capturedShoots.push(args); return { project: { id: 777 }, ...args }; } },
  };
  delete require.cache[ctPath];
  return require(ctPath);
}
function cleanup() {
  delete require.cache[ctPath];
  delete require.cache[dbPath];
  delete require.cache[orchPath];
}

// Two catalogue avatars exist; a third slug does not.
const catalogueRows = [
  { slug: 'aanya-kapoor', id: 10, name: 'Aanya' },
  { slug: 'rohan-mehra', id: 20, name: 'Rohan' },
];

const soloStory = {
  id: 1, tenant_id: null, slug: 'street-food-diary', name: 'Street Food Diary',
  category: 'viral_video', kind: 'reel', frame_count: 2, clip_seconds: 5,
  is_platform: true, is_story: true, status: 'ready',
  recipe: {
    brief: { concept: 'A first-person food diary', hook: 'eat the street with me' },
    cast: [{ key: 'lead', slug: 'aanya-kapoor', role: 'lead', name: 'Aanya' }],
    scenes: [{ time_of_day: 'evening', shots: [
      { character: 'lead', dialogue: 'Starting with chaat.', framing: 'medium' },
      { character: 'lead', dialogue: 'No regrets.', framing: 'close' },
    ] }],
  },
};
const duoStory = {
  id: 2, tenant_id: null, slug: 'chai-tapri-catchup', name: 'Chai Tapri Catch-Up',
  category: 'viral_video', kind: 'reel', frame_count: 2, clip_seconds: 5,
  is_platform: true, is_story: true, status: 'ready',
  recipe: {
    brief: { concept: 'Two friends catch up', hook: 'chai talks' },
    cast: [
      { key: 'lead', slug: 'aanya-kapoor', role: 'lead', name: 'Aanya' },
      { key: 'rohan', slug: 'rohan-mehra', role: 'costar', name: 'Rohan' },
    ],
    scenes: [{ time_of_day: 'evening', shots: [
      { character: 'lead', dialogue: 'Tell me everything.', framing: 'medium' },
      { character: 'rohan', dialogue: 'I quit.', framing: 'medium' },
    ] }],
  },
};
const comingSoonStory = {
  id: 3, tenant_id: null, slug: 'festival-plans-debate', name: 'Festival Plans Debate',
  category: 'viral_video', kind: 'reel', frame_count: 1, clip_seconds: 5,
  is_platform: true, is_story: true, status: 'ready',
  recipe: {
    brief: { concept: 'Two friends debate the plan', hook: 'planning is a job' },
    cast: [
      { key: 'lead', slug: 'aanya-kapoor', role: 'lead', name: 'Aanya' },
      { key: 'meera', slug: 'meera-iyer', role: 'costar', name: 'Meera' }, // not catalogued
    ],
    scenes: [{ shots: [{ character: 'lead', dialogue: 'Six sharp.', framing: 'medium' }] }],
  },
};

test('listStories flags availability from the catalogue', async () => {
  const pool = makePool()
    .on(/FROM content_templates/, () => ({ rows: [soloStory, duoStory, comingSoonStory] }))
    .on(/FROM avatars WHERE slug = ANY/, (sql, params) => ({
      rows: catalogueRows.filter((r) => params[0].includes(r.slug)),
    }));
  const CT = installFakes(pool);
  try {
    const stories = await CT.listStories(pool, 1);
    assert.strictEqual(stories.length, 3);
    const byId = new Map(stories.map((s) => [s.id, s]));
    assert.strictEqual(byId.get(1).available, true, 'solo Aanya story is available');
    assert.strictEqual(byId.get(2).available, true, 'duo (Aanya+Rohan) is available');
    assert.strictEqual(byId.get(3).available, false, 'story with an un-catalogued member is not');
    // The un-catalogued member is flagged individually.
    const meera = byId.get(3).cast.find((c) => c.slug === 'meera-iyer');
    assert.strictEqual(meera.available, false);
    // Dialogue never leaks into the browse list.
    assert.ok(!JSON.stringify(byId.get(1)).includes('chaat'));
  } finally { cleanup(); }
});

test('applyStory resolves cast, auto-selects, and shoots lead + costars', async () => {
  capturedShoots.length = 0;
  const selects = [];
  const pool = makePool()
    .on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [duoStory] })) // this.get()
    .on(/FROM avatars WHERE slug = ANY/, (sql, params) => ({
      rows: catalogueRows.filter((r) => params[0].includes(r.slug)),
    }))
    .on(/INSERT INTO catalogue_selections/, (sql, params) => { selects.push(params); return { rows: [] }; });
  const CT = installFakes(pool);
  try {
    const out = await CT.applyStory({ tenantId: 5, userId: 9, templateId: 2, tier: 'paid' });
    assert.strictEqual(out.project.id, 777);
    // Both catalogue avatars auto-selected for tenant 5.
    assert.strictEqual(selects.length, 2);
    assert.deepStrictEqual(selects.map((p) => p[1]).sort(), [10, 20]);
    assert.ok(selects.every((p) => p[0] === 5 && p[2] === 9));
    // createShoot got the lead as avatarId and the co-star as cast[].
    const shoot = capturedShoots[0];
    assert.strictEqual(shoot.avatarId, 10, 'lead Aanya is the shoot avatar');
    assert.strictEqual(shoot.kind, 'reel');
    assert.strictEqual(shoot.cast.length, 1);
    assert.strictEqual(shoot.cast[0].avatarId, 20, 'Rohan is the co-star');
    assert.strictEqual(shoot.cast[0].key, 'rohan');
    assert.ok(Array.isArray(shoot.scenes) && shoot.scenes[0].shots.length === 2);
    assert.strictEqual(shoot.tier, 'paid');
  } finally { cleanup(); }
});

test('applyStory refuses a story whose cast is not fully catalogued', async () => {
  capturedShoots.length = 0;
  const pool = makePool()
    .on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [comingSoonStory] }))
    .on(/FROM avatars WHERE slug = ANY/, (sql, params) => ({
      rows: catalogueRows.filter((r) => params[0].includes(r.slug)),
    }))
    .on(/INSERT INTO catalogue_selections/, () => ({ rows: [] }));
  const CT = installFakes(pool);
  try {
    await assert.rejects(
      () => CT.applyStory({ tenantId: 5, userId: 9, templateId: 3, tier: 'free' }),
      (e) => e.code === 'CAST_NOT_READY' && /meera-iyer/.test(e.message)
    );
    assert.strictEqual(capturedShoots.length, 0, 'no shoot when the cast is not ready');
  } finally { cleanup(); }
});

test('applyStory rejects a non-story template', async () => {
  const plain = { id: 4, tenant_id: null, kind: 'reel', is_story: false, recipe: { shots: [{}] } };
  const pool = makePool().on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [plain] }));
  const CT = installFakes(pool);
  try {
    await assert.rejects(
      () => CT.applyStory({ tenantId: 5, templateId: 4 }),
      (e) => e.code === 'NOT_A_STORY'
    );
  } finally { cleanup(); }
});

test('_resolveCatalogueCast remaps a non-lead-keyed lead onto shot characters', async () => {
  // A story whose lead member uses a custom key still shoots correctly: the
  // orchestrator's lead is key 'lead', so applyStory remaps the lead's shots.
  capturedShoots.length = 0;
  const oddLead = {
    id: 6, tenant_id: null, slug: 'odd', name: 'Odd', kind: 'reel', frame_count: 1, clip_seconds: 5,
    is_platform: true, is_story: true,
    recipe: {
      brief: {}, cast: [{ key: 'hero', slug: 'aanya-kapoor', role: 'lead', name: 'Aanya' }],
      scenes: [{ shots: [{ character: 'hero', dialogue: 'Hi.', framing: 'close' }] }],
    },
  };
  const pool = makePool()
    .on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [oddLead] }))
    .on(/FROM avatars WHERE slug = ANY/, (sql, params) => ({ rows: catalogueRows.filter((r) => params[0].includes(r.slug)) }))
    .on(/INSERT INTO catalogue_selections/, () => ({ rows: [] }));
  const CT = installFakes(pool);
  try {
    await CT.applyStory({ tenantId: 5, templateId: 6 });
    const shoot = capturedShoots[0];
    assert.strictEqual(shoot.avatarId, 10);
    assert.strictEqual(shoot.scenes[0].shots[0].character, 'lead', 'lead shot remapped to key lead');
  } finally { cleanup(); }
});
