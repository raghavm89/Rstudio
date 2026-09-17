'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ShootPlanner = require('../src/services/studio/shootPlanner');

const vocab = {
  framing: ['close', 'medium', 'wide', 'full'],
  light_direction: ['camera_left', 'camera_right', 'front'],
  light_quality: ['soft', 'hard'],
  expression: ['neutral', 'soft_smile', 'confident'],
  time_of_day: ['morning', 'afternoon', 'golden', 'night'],
  intensity: ['light', 'medium', 'strong'],
  expression_gloss: null,
};

const roster = [
  { key: 'lead', name: 'Aanya', subjectType: 'person' },
  { key: 'mango', name: 'Mango Mascot', subjectType: 'character' },
];

test('conversation system prompt exposes per-scene character + dialogue and the cast', () => {
  const sys = ShootPlanner.buildSystem('reel', true, 3, vocab, roster);
  assert.match(sys, /"character":\s*"lead\|mango"/, 'scene schema offers the cast keys');
  assert.match(sys, /"dialogue"/, 'scene schema has a dialogue field');
  assert.match(sys, /MULTI-CHARACTER CONVERSATION/, 'conversation instruction present');
  assert.match(sys, /"lead" = Aanya/, 'lead named');
  assert.match(sys, /"mango" = Mango Mascot/, 'co-star named');
  assert.match(sys, /SHOT-REVERSE-SHOT/, 'shot-reverse-shot instruction present');
});

test('single-character (lead only) prompt has no character/dialogue fields — unchanged behaviour', () => {
  const sys = ShootPlanner.buildSystem('reel', true, 3, vocab, [{ key: 'lead', name: 'Aanya', subjectType: 'person' }]);
  assert.ok(!/"character":/.test(sys), 'no character field for a single-character reel');
  assert.ok(!/"dialogue"/.test(sys), 'no dialogue field for a single-character reel');
  assert.ok(!/MULTI-CHARACTER/.test(sys), 'no conversation instruction');
});

test('a still (non-motion) shoot never becomes a conversation even with a cast', () => {
  const sys = ShootPlanner.buildSystem('post', false, 1, vocab, roster);
  assert.ok(!/"character":/.test(sys), 'no per-scene character in a still shoot');
  assert.ok(!/"dialogue"/.test(sys), 'no dialogue in a still shoot');
});
