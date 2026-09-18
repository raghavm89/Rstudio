'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * Story templates — role-based: a story is a SCRIPT with open ROLES, browsed by
 * GENRE, and CAST by the user from the catalogue (person or character). These
 * exercise contentTemplate's story path with a fake db + fake Orchestrator
 * (require-cache injection), no Postgres.
 */

const dbPath = require.resolve('../src/config/db');
const orchPath = require.resolve('../src/services/studio/orchestrator');
const ctPath = require.resolve('../src/services/studio/contentTemplate');

function makePool() {
  const pool = {
    handlers: [],
    on(m, fn) { this.handlers.push([m, fn]); return this; },
    async query(sql, params) {
      for (const [m, fn] of this.handlers) if (m.test(sql)) return fn(sql, params);
      return { rows: [] };
    },
  };
  return pool;
}
const capturedShoots = [];
function install(pool) {
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true,
    exports: { createShoot: async (a) => { capturedShoots.push(a); return { project: { id: 900 }, ...a }; } } };
  delete require.cache[ctPath];
  return require(ctPath);
}
function cleanup() { delete require.cache[ctPath]; delete require.cache[dbPath]; delete require.cache[orchPath]; }

const duoStory = {
  id: 2, tenant_id: null, slug: 'chai-tapri-catchup', name: 'Chai Tapri Catch-Up',
  category: 'viral_video', kind: 'reel', genre: 'friendship', frame_count: 4, clip_seconds: 5,
  is_platform: true, is_story: true, status: 'ready',
  recipe: {
    genre: 'friendship', brief: { concept: 'Two friends catch up', hook: 'chai talks' },
    roles: [
      { key: 'lead', label: 'The one who asks', subject: 'any' },
      { key: 'friend', label: 'The friend', subject: 'any' },
    ],
    scenes: [{ shots: [
      { character: 'lead', dialogue: 'Tell me.', framing: 'medium' },
      { character: 'friend', dialogue: 'I quit.', framing: 'medium' },
    ] }],
  },
};

test('_storyRoles reads recipe.roles, and derives from scenes when absent', () => {
  const CT = install(makePool());
  try {
    assert.deepStrictEqual(CT._storyRoles(duoStory.recipe).map((r) => r.key), ['lead', 'friend']);
    const derived = CT._storyRoles({ scenes: [{ shots: [{ character: 'lead' }, { character: 'x' }] }] });
    assert.deepStrictEqual(derived.map((r) => r.key), ['lead', 'x']);
  } finally { cleanup(); }
});

test('castOptions returns catalogue + own ready avatars (person or character)', async () => {
  const pool = makePool().on(/FROM avatars a\s+JOIN avatar_loras/, () => ({ rows: [
    { id: 10, slug: 'aanya-kapoor', name: 'Aanya', subject_type: 'person', is_catalogue: true, preview_url: '/x.jpg' },
    { id: 20, slug: 'zoq-mascot', name: 'Mango', subject_type: 'character', is_catalogue: true, preview_url: null },
  ] }));
  const CT = install(pool);
  try {
    const cast = await CT.castOptions(pool, 1);
    assert.strictEqual(cast.length, 2);
    assert.strictEqual(cast[0].subject_type, 'person');
    assert.strictEqual(cast[1].subject_type, 'character');
  } finally { cleanup(); }
});

test('listStories returns genre + roles, no dialogue', async () => {
  const pool = makePool().on(/FROM content_templates/, () => ({ rows: [duoStory] }));
  const CT = install(pool);
  try {
    const stories = await CT.listStories(pool, 1);
    assert.strictEqual(stories[0].genre, 'friendship');
    assert.deepStrictEqual(stories[0].roles.map((r) => r.key), ['lead', 'friend']);
    assert.ok(!JSON.stringify(stories[0]).includes('I quit'));
  } finally { cleanup(); }
});

test('applyStory casts each role, auto-selects catalogue picks, shoots lead + costars', async () => {
  capturedShoots.length = 0;
  const selects = [];
  const pool = makePool()
    .on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [duoStory] }))
    .on(/FROM avatars WHERE id = ANY/, (sql, p) => ({ rows: [{ id: 10 }, { id: 20 }].filter((r) => p[0].includes(r.id)) }))
    .on(/INSERT INTO catalogue_selections/, (sql, p) => { selects.push(p); return { rows: [] }; });
  const CT = install(pool);
  try {
    const out = await CT.applyStory({ tenantId: 5, userId: 9, templateId: 2, casting: { lead: 10, friend: 20 }, tier: 'paid' });
    assert.strictEqual(out.project.id, 900);
    assert.deepStrictEqual(selects.map((p) => p[1]).sort(), [10, 20]);
    const shoot = capturedShoots[0];
    assert.strictEqual(shoot.avatarId, 10, 'lead is the casting[lead]');
    assert.strictEqual(shoot.cast.length, 1);
    assert.strictEqual(shoot.cast[0].key, 'friend');
    assert.strictEqual(shoot.cast[0].avatarId, 20);
    assert.strictEqual(shoot.scenes[0].shots.length, 2);
  } finally { cleanup(); }
});

test('applyStory refuses an incomplete cast', async () => {
  capturedShoots.length = 0;
  const pool = makePool().on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [duoStory] }));
  const CT = install(pool);
  try {
    await assert.rejects(
      () => CT.applyStory({ tenantId: 5, templateId: 2, casting: { lead: 10 } }),
      (e) => e.code === 'INCOMPLETE_CAST' && /friend/i.test(e.message)
    );
    assert.strictEqual(capturedShoots.length, 0);
  } finally { cleanup(); }
});

test('applyStory rejects a non-story template', async () => {
  const pool = makePool().on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [{ id: 4, is_story: false, kind: 'reel', recipe: {} }] }));
  const CT = install(pool);
  try {
    await assert.rejects(() => CT.applyStory({ tenantId: 5, templateId: 4, casting: {} }), (e) => e.code === 'NOT_A_STORY');
  } finally { cleanup(); }
});

test('a non-lead-keyed lead is remapped onto its shots', async () => {
  capturedShoots.length = 0;
  const oddLead = {
    id: 6, tenant_id: null, kind: 'reel', frame_count: 1, clip_seconds: 5, is_story: true, is_platform: true,
    recipe: { roles: [{ key: 'hero', label: 'Hero' }], scenes: [{ shots: [{ character: 'hero', dialogue: 'Hi', framing: 'close' }] }] },
  };
  const pool = makePool()
    .on(/FROM content_templates WHERE id = \$1/, () => ({ rows: [oddLead] }))
    .on(/FROM avatars WHERE id = ANY/, () => ({ rows: [] }))
    .on(/INSERT INTO catalogue_selections/, () => ({ rows: [] }));
  const CT = install(pool);
  try {
    await CT.applyStory({ tenantId: 5, templateId: 6, casting: { hero: 30 } });
    const shoot = capturedShoots[0];
    assert.strictEqual(shoot.avatarId, 30);
    assert.strictEqual(shoot.scenes[0].shots[0].character, 'lead');
  } finally { cleanup(); }
});
