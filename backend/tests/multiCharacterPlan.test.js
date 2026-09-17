'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Orchestrator = require('../src/services/studio/orchestrator');

const keys = (stages) => stages.map((s) => s.key);
const find = (stages, key) => stages.find((s) => s.key === key);

test('dialogue mode: one voice job per dialogue shot, none for the rest', () => {
  const { stages } = Orchestrator.planFor({
    kind: 'reel', frameCount: 3, clipSeconds: 5, wantsVoice: true, wantsLipsync: true, dialogueShots: [1, 3],
  });
  const k = keys(stages);
  assert.ok(k.includes('voice:1'), 'shot 1 voiced');
  assert.ok(k.includes('voice:3'), 'shot 3 voiced');
  assert.ok(!k.includes('voice:2'), 'shot 2 (no dialogue) not voiced');
  assert.ok(!k.includes('voice'), 'no single whole-reel voice job in dialogue mode');
});

test('dialogue + lipsync (Phase 2b): per-shot lipsync, each relipping its own clip to its own line', () => {
  const { stages } = Orchestrator.planFor({
    kind: 'reel', frameCount: 3, clipSeconds: 5, wantsVoice: true, wantsLipsync: true, dialogueShots: [1, 3],
  });
  const k = keys(stages);
  assert.ok(!k.includes('lipsync'), 'no single post-assemble lipsync in dialogue mode');
  assert.ok(k.includes('lipsync:1') && k.includes('lipsync:3'), 'per-shot lipsync for each dialogue shot');
  assert.ok(!k.includes('lipsync:2'), 'no lipsync for the shot with no dialogue');
  const lip1 = find(stages, 'lipsync:1');
  assert.ok(lip1.after.includes('motion:1') && lip1.after.includes('voice:1'), 'lipsync:1 relips motion:1 to voice:1');
  assert.ok(lip1.meter && lip1.meter.metric === 'credits', 'per-shot lipsync is metered');
  const assemble = find(stages, 'assemble');
  for (const dep of ['motion:1', 'motion:2', 'motion:3', 'voice:1', 'voice:3', 'lipsync:1', 'lipsync:3']) {
    assert.ok(assemble.after.includes(dep), `assemble waits on ${dep}`);
  }
  assert.ok(!assemble.after.includes('lipsync:2'), 'assemble does not wait on a lipsync that was never queued');
});

test('dialogue WITHOUT lipsync (Phase 2a): per-shot voice, no lipsync, assemble waits on the voices', () => {
  const { stages } = Orchestrator.planFor({
    kind: 'reel', frameCount: 3, clipSeconds: 5, wantsVoice: true, wantsLipsync: false, dialogueShots: [1, 3],
  });
  const k = keys(stages);
  assert.ok(!k.some((x) => x.startsWith('lipsync')), 'no lipsync at all without wantsLipsync');
  const assemble = find(stages, 'assemble');
  for (const dep of ['motion:1', 'motion:2', 'motion:3', 'voice:1', 'voice:3']) {
    assert.ok(assemble.after.includes(dep), `assemble waits on ${dep}`);
  }
});

test('legacy mode (no dialogue): single voice + post-assemble lipsync, unchanged', () => {
  const { stages } = Orchestrator.planFor({
    kind: 'reel', frameCount: 2, clipSeconds: 5, wantsVoice: true, wantsLipsync: true, dialogueShots: [],
  });
  const k = keys(stages);
  assert.ok(k.includes('voice'), 'single whole-reel voice');
  assert.ok(k.includes('lipsync'), 'post-assemble lipsync present');
  assert.ok(!k.includes('voice:1'), 'no per-shot voice in legacy mode');
});

test('a silent multi-character reel (no dialogue, no voice) still assembles', () => {
  const { stages } = Orchestrator.planFor({
    kind: 'reel', frameCount: 2, clipSeconds: 5, wantsVoice: false, wantsLipsync: false, dialogueShots: [],
  });
  const k = keys(stages);
  assert.ok(!k.includes('voice'), 'no voice');
  assert.ok(k.includes('assemble'), 'assemble present');
  assert.ok(k.includes('copy'), 'copy present');
});
