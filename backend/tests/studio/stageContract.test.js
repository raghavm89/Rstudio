'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { STAGES, RUNNERS } = require('../../src/controllers/studioJobController');

/**
 * Enqueue and claim must agree on the vocabulary.
 *
 * They are two ends of one contract, and they lived in different files with no
 * check between them. `lora_train` was added to the enqueue side in the training
 * service and never reached the claim allowlist, so a training job could be
 * created and then never handed to a worker — the worker asking for it was
 * refused with "Unknown stage", and the job sat in the queue looking exactly
 * like nobody had got round to it yet.
 *
 * That is the worst shape a queue bug can take: no error at the point of
 * failure, no error in the job, and a symptom ("nothing is happening") that
 * points at the worker rather than at the contract it was refused by.
 *
 * This test reads the stages the code actually enqueues out of the source and
 * asserts every one of them is claimable. It is deliberately a source scan
 * rather than a list: a list would have to be updated by the same person who
 * forgot to update the allowlist.
 */

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'studio');

/** Every `stage: '…'` literal the services enqueue with. */
function stagesEnqueuedInSource() {
  const found = new Map();
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const m of src.matchAll(/stage:\s*'([a-z_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

test('every stage the code enqueues can also be claimed', () => {
  const enqueued = stagesEnqueuedInSource();
  assert.ok(enqueued.size > 0, 'found no stage literals — has the shape of the code changed?');

  const unclaimable = [...enqueued.entries()].filter(([stage]) => !STAGES.includes(stage));
  assert.deepStrictEqual(
    unclaimable, [],
    `these stages can be enqueued but never claimed: ${unclaimable.map(([s, f]) => `${s} (${f})`).join(', ')}`
  );
});

test('lora_train specifically is claimable', () => {
  // Named on its own because this is the one that was broken, and a regression
  // here is silent: training would queue and never start.
  assert.ok(STAGES.includes('lora_train'));
});

test('the runner a training job asks for is a runner the API accepts', () => {
  // `loraTraining` hard-codes runner 'cloud'. If the allowlist ever loses it,
  // claiming fails the same invisible way.
  const src = fs.readFileSync(path.join(SRC, 'loraTraining.js'), 'utf8');
  const m = src.match(/stage:\s*'lora_train',\s*\n\s*runner:\s*'([a-z]+)'/);
  assert.ok(m, 'could not find the runner the training job is enqueued with');
  assert.ok(RUNNERS.includes(m[1]), `training asks for runner '${m[1]}', which the API does not accept`);
});

test('the metered stages are all real stages', () => {
  // A meter keyed to a stage nobody can enqueue would silently never charge.
  const { METERED } = require('../../src/controllers/studioJobController');
  if (!METERED) return;   // not exported in every version
  for (const stage of Object.keys(METERED)) {
    assert.ok(STAGES.includes(stage), `METERED names '${stage}', which is not a stage`);
  }
});
