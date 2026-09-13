'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Voice = require('../src/services/studio/voiceStage');

test('pickScript prefers script, then voiceover, hook, concept', () => {
  assert.strictEqual(Voice.pickScript({ script: 'S', hook: 'H' }), 'S');
  assert.strictEqual(Voice.pickScript({ voiceover: 'V', hook: 'H' }), 'V');
  assert.strictEqual(Voice.pickScript({ hook: 'H', concept: 'C' }), 'H');
  assert.strictEqual(Voice.pickScript({ concept: 'C' }), 'C');
  assert.strictEqual(Voice.pickScript({}), null);
  assert.strictEqual(Voice.pickScript({ script: '   ' }), null, 'whitespace is not a script');
});

test('TTS refuses without an API key, permanently', async () => {
  await assert.rejects(
    () => Voice.elevenLabsTts({ text: 'hi', voiceId: 'v', apiKey: '', fetchImpl: async () => ({}) }),
    (e) => e.permanent === true
  );
});

test('TTS treats a 4xx as permanent and a 429 as retryable', async () => {
  const mk = (status) => async () => ({ ok: false, status, text: async () => 'x' });
  await assert.rejects(() => Voice.elevenLabsTts({ text: 't', voiceId: 'v', apiKey: 'k', fetchImpl: mk(400) }), (e) => e.permanent === true);
  await assert.rejects(() => Voice.elevenLabsTts({ text: 't', voiceId: 'v', apiKey: 'k', fetchImpl: mk(429) }), (e) => e.permanent === false);
});

function fakeDb(row) {
  return { async query() { return { rows: row ? [row] : [] }; } };
}
const job = { stage: 'voice', project_id: 10, tenant_id: 1 };

test('execute reads the brief + locked voice, TTS-es, and returns an audio asset', async () => {
  const db = fakeDb({ brief: { hook: 'bas, we move.' }, name: 'Aanya', voice_provider: 'elevenlabs', voice_id: 'vx' });
  let seen = null;
  const tts = async (args) => { seen = args; return Buffer.from('MP3DATA'); };
  const store = async (j, a) => { return { key: `t${j.tenant_id}/voice.mp3`, filename: a.filename, bytes: 7 }; };
  const out = await Voice.execute(job, { db, tts, store });
  assert.strictEqual(seen.text, 'bas, we move.');
  assert.strictEqual(seen.voiceId, 'vx');
  assert.strictEqual(out.assets.length, 1);
  assert.match(out.assets[0].key, /voice\.mp3/);
  assert.strictEqual(out.chars, 'bas, we move.'.length);
});

test('execute refuses when the avatar has no locked voice, or the brief has no words', async () => {
  const noVoice = fakeDb({ brief: { hook: 'x' }, voice_provider: 'elevenlabs', voice_id: null });
  await assert.rejects(() => Voice.execute(job, { db: noVoice, tts: async () => Buffer.from('x'), store: async () => ({}) }),
    (e) => e.permanent === true && /locked voice/.test(e.message));
  const noScript = fakeDb({ brief: {}, voice_provider: 'elevenlabs', voice_id: 'vx' });
  await assert.rejects(() => Voice.execute(job, { db: noScript, tts: async () => Buffer.from('x'), store: async () => ({}) }),
    (e) => e.permanent === true && /No script/.test(e.message));
});
