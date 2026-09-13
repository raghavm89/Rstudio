'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { CloudRunner, DEFAULTS, stagesFor } = require('../src/services/studio/cloudRunner');

/**
 * Rendering stopped being something you have to remember to start.
 *
 * `npm run studio:worker` is a reasonable thing to ask of a GPU box and an
 * unreasonable thing to ask of a product: forget it and the jobs queue, the
 * face screen counts zero of twenty-four, and nothing anywhere says the reason
 * is that nobody ran a command. A fal render is an HTTPS request and a wait, so
 * there was never a model resident here to justify a process of its own.
 */

// ── What it will and will not take ───────────────────────────────────────────

test('it claims only what its provider can actually run', () => {
  // A stage fal does not handle fails as UNSUPPORTED_STAGE, which is PERMANENT.
  // Claiming one means a frame somebody paid for is destroyed rather than left
  // for the worker that could have rendered it.
  const partial = { supports: (s) => s === 'seed_still' };
  assert.deepStrictEqual(stagesFor(partial), ['seed_still']);

  const full = { supports: () => true };
  const all = stagesFor(full);
  assert.ok(all.includes('seed_still') && all.includes('still'), JSON.stringify(all));

  // Every stage it may claim has to be one the API agrees exists, or the job
  // could never have been enqueued under that name in the first place.
  const { STAGES } = require('../src/controllers/studioJobController');
  for (const stage of all) {
    assert.ok(STAGES.includes(stage), `the runner would claim '${stage}', which is not a stage`);
  }
});

test('it asks whether it can render before it claims, not after', async () => {
  // Claiming work it cannot start burns an attempt and strands the job for a
  // whole lease period — and, worse, makes an unconfigured server look like a
  // busy one to the screen that is watching.
  let claimed = false;
  const RenderJob = require('../src/models/renderJob');
  const realClaim = RenderJob.claimNext;
  RenderJob.claimNext = async () => { claimed = true; return null; };
  try {
    const out = await CloudRunner.tick({ provider: { isReady: async () => false, supports: () => true } });
    assert.strictEqual(out, null);
    assert.strictEqual(claimed, false, 'a runner with no key must not touch the queue');
  } finally {
    RenderJob.claimNext = realClaim;
  }
});

test('when it cannot render it answers no, rather than throwing at whoever asked', async () => {
  // `ready()` is called from a poll on the culling screen. A throw there turns
  // "we are not configured to render" into a 500 on the page that exists to
  // explain why nothing is rendering.
  const saved = process.env.FAL_KEY;
  delete process.env.FAL_KEY;
  delete CloudRunner._provider;
  try {
    assert.strictEqual(await CloudRunner.ready(), false, 'no key means not ready');

    // And a provider that cannot even be asked is still an answer, not an error.
    CloudRunner._provider = { isReady() { throw new Error('no network, no anything'); } };
    assert.strictEqual(await CloudRunner.ready(), false);
  } finally {
    if (saved !== undefined) process.env.FAL_KEY = saved;
    delete CloudRunner._provider;
  }
});

// ── How hard it goes ─────────────────────────────────────────────────────────

test('several renders run at once, within a bound', () => {
  // Waiting on fal is not work. One at a time makes a 24-frame batch take
  // twenty-four renders end to end — a quarter of an hour of somebody watching
  // a progress bar for no reason.
  assert.ok(DEFAULTS.concurrency >= 2, 'sequential fal renders are a wasted quarter of an hour');
  assert.ok(DEFAULTS.concurrency <= 12, 'and unbounded fan-out is a way to exhaust the connection pool');

  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'cloudRunner.js')));
  assert.match(src, /STUDIO_CLOUD_CONCURRENCY/, 'it must be tunable without an edit');

  // Clamped for real, not just apparently: an env var is a typo away from
  // opening as many sockets and pool connections as the number happens to say.
  const withEnv = (value) => {
    const saved = process.env.STUDIO_CLOUD_CONCURRENCY;
    process.env.STUDIO_CLOUD_CONCURRENCY = value;
    delete require.cache[require.resolve('../src/services/studio/cloudRunner')];
    try {
      return require('../src/services/studio/cloudRunner').DEFAULTS.concurrency;
    } finally {
      if (saved === undefined) delete process.env.STUDIO_CLOUD_CONCURRENCY;
      else process.env.STUDIO_CLOUD_CONCURRENCY = saved;
      delete require.cache[require.resolve('../src/services/studio/cloudRunner')];
    }
  };
  assert.strictEqual(withEnv('9999'), 12, 'a fat-fingered env var must not uncork the fan-out');
  assert.strictEqual(withEnv('0'), 1, 'and zero must not stop rendering altogether');
  assert.strictEqual(withEnv('nonsense'), 3, 'nor must a non-number');
  assert.strictEqual(withEnv('4'), 4, 'a real value is honoured');

  // Each slot claims for itself. One claimer handing work out would serialise
  // the claim and leave a fast slot waiting on the slowest of a batch.
  assert.match(src, /Promise\.all\(Array\.from\(\{ length: concurrency \}/);
});

test('a lease is renewed while a render is in flight, and abandoned when lost', () => {
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'cloudRunner.js')));
  assert.match(src, /RenderJob\.heartbeat/, 'a fal render outlives a sane lease');
  assert.match(src, /Math\.max\(10_000, \(leaseSeconds \* 1000\) \/ 3\)/,
    'a third of the lease, so two consecutive misses still leave room');
  assert.match(src, /clearInterval\(beat\)/);

  // Storing bytes for a job that was reaped ten minutes ago spends time on an
  // object nothing will ever reference.
  const store = src.indexOf('JobUpload.store');
  const guard = src.indexOf('if (lost) return null;');
  assert.ok(store > -1 && guard > -1, 'both the store and the guard must be present');
  assert.ok(guard < store, 'the lease is checked before the bytes are written');
});

// ── One copy of the money ────────────────────────────────────────────────────

test('settlement has exactly one home', () => {
  // Two renderers finishing jobs two different ways is two places for the
  // quota settle, the seed-frame refund and the pool insert to drift, and the
  // failure mode of drift here is money: a frame charged twice, or a failed one
  // never given back.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioJobController.js')));
  const run = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'cloudRunner.js')));

  for (const [name, src] of [['the HTTP controller', ctl], ['the cloud runner', run]]) {
    assert.match(src, /JobResult\.settle/, `${name} must settle through the shared service`);
    for (const forbidden of ['StudioUsage.settle', 'SeedBatch.releaseFrame', 'SeedCandidates.recordGenerated']) {
      assert.ok(!src.includes(forbidden),
        `${name} keeps its own copy of ${forbidden} — that is the drift this refactor removed`);
    }
  }

  // And the shared service is where it all actually happens.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));
  for (const required of ['StudioUsage.settle', 'SeedBatch.releaseFrame', 'SeedCandidates.recordGenerated', 'LoraTraining.recordTrained']) {
    assert.ok(svc.includes(required), `jobResult must own ${required}`);
  }
});

test('a key is derived from the job on both paths, never composed by the renderer', () => {
  // A renderer that could nominate its own key could write into another
  // tenant's prefix, and the whole point of the `t{tenant}/…` layout is that
  // the path itself is the attribution.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioJobController.js')));
  const run = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'cloudRunner.js')));
  assert.match(ctl, /JobUpload\.targetFor/);
  assert.match(run, /JobUpload\.store/);

  const up = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobUpload.js')));
  assert.match(up, /tenantId: job\.tenant_id/, 'the tenant comes off the job row');
  assert.ok(!/tenantId: [a-z]*[Rr]eq/.test(up), 'and never off the request');
});

test('the render worker still cannot reach the database', () => {
  // It holds a shared secret that lives on somebody's laptop, and the entire
  // worker grant rests on it never being able to read tenant content. Sharing
  // a table of six strings with the API must not drag `config/db` across that
  // line.
  const kinds = read(path.join(ROOT, 'src', 'services', 'studio', 'stageKinds.js'));
  assert.ok(!/require\(/.test(strip(kinds)),
    'stageKinds must require nothing, or the worker inherits whatever it pulls in');

  const worker = strip(read(path.join(ROOT, 'worker', 'index.js')));
  const reaches = worker.match(/require\('\.\.\/src\/[^']+'\)/g) || [];
  for (const r of reaches) {
    assert.match(r, /stageKinds/, `the worker requires ${r} — check it cannot reach the database through it`);
  }

  // The two must agree on where output goes, which is the reason they share it.
  const { KIND_BY_STAGE } = require('../src/services/studio/stageKinds');
  assert.strictEqual(KIND_BY_STAGE.seed_still, 'still',
    'a candidate frame filed anywhere else is one the culling screen cannot find');
});

// ── Starting itself ──────────────────────────────────────────────────────────

test('the backend starts it, and says so when it cannot', () => {
  const app = read(path.join(ROOT, 'src', 'app.js'));
  assert.match(app, /CloudRunner/, 'nothing starts it otherwise, which is the whole bug');
  assert.match(app, /STUDIO_CLOUD_RUNNER !== 'off'/, 'and a deployment must be able to opt out');
  assert.match(app, /NODE_ENV !== 'test'/, 'a test run must not start rendering');

  const stripped = strip(app);
  const ready = stripped.indexOf('CloudRunner.ready()');
  const start = stripped.indexOf('CloudRunner.start()');
  assert.ok(ready > -1 && start > -1, 'both the check and the start must be present');
  assert.ok(ready < start, 'readiness is checked before the loop is started');
  assert.match(stripped, /no FAL_KEY/, 'a server that cannot render has to say so at boot');
});

test('the screen explains a stall instead of describing it', () => {
  // "Nothing has started these" is true and useless on its own — it is the
  // symptom the screen is already showing. There is one common cause now that
  // renders happen in the API process, and it is worth naming.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /generating\.renderer_ready = await CloudRunner\.ready\(\)/);

  // Only when something is actually wrong: a healthy poll must not pay for it.
  const asked = ctl.indexOf('CloudRunner.ready()');
  const guard = ctl.indexOf('if (generating && generating.stalled)');
  assert.ok(asked > -1 && guard > -1, 'both the guard and the question must be present');
  assert.ok(guard < asked, 'the reason is only looked up once a batch has actually stalled');

  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /renderer_ready === false/, 'the screen must branch on the reason');
  assert.match(page, /FAL_KEY/, 'and name the missing thing, for the one person who can fix it');
  assert.doesNotMatch(strip(page), /npm run/,
    'a customer has no repository, no GPU and no terminal — and now nobody needs one');
});
