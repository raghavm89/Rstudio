'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT  = path.join(__dirname, '..');
const read  = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src   = (...p) => strip(read(path.join(ROOT, ...p)));

/**
 * Calibration, as something the product does.
 *
 * `calibration.js` could always turn samples into a baseline and could never
 * produce a sample. `studio/calibrate.js` said so: "the recording loop is still
 * to build". The consequence was not a missing feature but a deadlock —
 * `activate` refuses an uncalibrated model, so every trained model was stuck
 * one step short of being usable, and the screen had nothing to offer but a
 * command that did not exist.
 */

// ── The stage ────────────────────────────────────────────────────────────────

test('calibration frames are a stage, and nobody bills the customer for them', () => {
  const { STAGES, METERED } = require('../src/controllers/studioJobController');
  assert.ok(STAGES.includes('calib_still'),
    'enqueue and claim have to agree on the vocabulary — lora_train is the record of what '
    + 'happens when they do not');
  assert.ok(!('calib_still' in METERED));

  // Checked at the source too, so a meter added where METERED actually lives
  // cannot slip past the re-export.
  const settle = src('src', 'services', 'studio', 'jobResult.js');
  const table = settle.slice(settle.indexOf('const METERED = {'), settle.indexOf('async function inTransaction'));
  assert.ok(!/\bcalib_still\s*:/.test(table),
    'billing calibration to still_megapixels charges a month of posts to find out whether '
    + 'the avatar works — the bug that took seed frames out of that meter, one step later');
});

test('the provider can claim it, and renders it with the LoRA adapter', () => {
  const { ENDPOINTS, FalProvider } = require('../worker/providers/fal');
  assert.ok('calib_still' in ENDPOINTS,
    'supports() reads these keys; without one the in-process runner never picks the stage up');
  assert.equal(ENDPOINTS.calib_still, ENDPOINTS.still,
    'same render, same endpoint — the separation is about the meter, not the model');

  const p = new FalProvider({ apiKey: 'k' });
  assert.ok(p.supports('calib_still'));

  // The endpoint is resolved from the JOB's stage. Hard-coding `still` here
  // would work today and quietly ignore FAL_CALIB_MODEL forever.
  const fal = src('worker', 'providers', 'fal.js');
  const runStill = fal.slice(fal.indexOf('async runStill('), fal.indexOf('async runSeedStill('));
  assert.ok(/this\.endpoints\[(job\.)?stage\]/.test(runStill),
    'runStill must look the endpoint up by the job stage, not by the literal "still"');
  assert.ok(!/submit\('still'/.test(runStill));
});

test('a calibration frame is filed where the culling screen looks for stills', () => {
  const { kindForStage } = require('../src/services/studio/stageKinds');
  assert.equal(kindForStage('calib_still'), 'still');
});

// ── The deadlock this exists to break ────────────────────────────────────────

test('the frames name the inactive model instead of looking up the active one', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  assert.match(run, /lora:\s*\{\s*path:\s*row\.file_path/,
    'the payload NAMES the model; promptStage resolves `AND l.active` and would fail NO_LORA');

  const ctx = run.slice(run.indexOf('async function context('), run.indexOf('async function vocabularyFor('));
  assert.ok(/FROM avatar_loras l/.test(ctx));
  assert.ok(!/l\.active/.test(ctx.replace(/l\.active,/, '')),
    'the look-up must not filter on active — the model being calibrated never is');

  // And the guard that matters is untouched.
  const prompt = src('src', 'services', 'studio', 'promptStage.js');
  assert.match(prompt, /LEFT JOIN avatar_loras\s+l\s+ON l\.avatar_id = a\.id AND l\.active/,
    'a shoot must still refuse to render with an unproven model');
});

test('an active model is not recalibrated under work already published', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  const submit = run.slice(run.indexOf('async function submit('));
  assert.match(submit, /if \(row\.active\)/);
  assert.match(submit, /ALREADY_ACTIVE/);
});

// ── What the measurement has to see ──────────────────────────────────────────

test('the samples of one cell span the conditions a shoot produces', () => {
  const { NUISANCE } = require('../src/services/studio/calibrationRun');

  const setup = (n) => `${n.light_direction}/${n.light_quality}`;
  const lights = new Set(NUISANCE.map(setup));
  assert.equal(lights.size, NUISANCE.length,
    'tolerance is two standard deviations of the SAMPLE. A cell measured under one light '
    + 'yields a tolerance that covers one light, and then the first backlit frame of a real '
    + 'shoot scores below the floor and is rejected for having the wrong face, which it does not');

  // The default cell is SIX samples and the list is walked `sample % length`,
  // so it is the first six that decide what a cell actually sees. Asserting
  // only that the whole list is varied lets a duplicate hide inside the part
  // every cell uses while two entries nothing reaches carry the count.
  const used = new Set(NUISANCE.slice(0, 6).map(setup));
  assert.equal(used.size, 6, 'the six setups a default cell walks must all differ');
  assert.ok(NUISANCE.some((n) => n.light_direction.startsWith('back')),
    'backlit frames are the hard case and the shoot will produce them');
  assert.equal(new Set(NUISANCE.map((n) => n.pose_key)).size, NUISANCE.length,
    'pose varies too, for the same reason');

  // It is the same error calibration.js warns about at the top, in its other
  // form: never generating the low scorers makes the sample tighter than
  // reality just as surely as dropping them does.
  const calib = src('src', 'services', 'studio', 'calibration.js');
  assert.ok(!/filter.*(score|similarity).*>/.test(calib), 'and low scores are still never dropped');
});

test('each frame of a cell is a different draw, reproducibly', () => {
  const { seedFor } = require('../src/services/studio/calibrationRun');
  const seeds = new Set([0, 1, 2, 3, 4, 5].map((i) => seedFor(7, 'neutral', 'medium', i)));
  assert.equal(seeds.size, 6, 'six seeds, or six copies of one frame');
  assert.equal(seedFor(7, 'neutral', 'medium', 3), seedFor(7, 'neutral', 'medium', 3),
    'a retry must reproduce its frame, or regenerating sample 3 changes what the other five measured');
  assert.notEqual(seedFor(7, 'neutral', 'medium', 3), seedFor(7, 'shy', 'medium', 3));
});

test('a preset is measured when the prompt can actually produce it', () => {
  const { expressiblePresets } = require('../src/services/studio/comfyui/buildWorkflow');
  const vocab = [
    { facet: 'expression', option_key: 'neutral',   fragment: 'a relaxed neutral expression' },
    { facet: 'expression', option_key: 'crying',    fragment: 'crying, the eyes wet' },
    { facet: 'expression', option_key: 'hollow',    fragment: '   ' },
    { facet: 'framing',    option_key: 'surprised', fragment: 'not an expression fragment' },
  ];
  const got = expressiblePresets(vocab, [
    { key: 'neutral' }, { key: 'crying' }, { key: 'surprised' }, { key: 'hollow' },
  ]).map((p) => p.key);

  assert.deepEqual(got, ['neutral', 'crying'],
    'derived from the vocabulary, so a preset added without a fragment cannot quietly '
    + 'render neutral frames filed under its new name');
  assert.ok(!got.includes('surprised'),
    'a fragment under a different facet is not an expression — this is how surprised and '
    + 'anxious fell through to the neutral default in the first place');
  assert.ok(!got.includes('hollow'), 'and an empty fragment expresses nothing');

  // A blend or a follow-on no longer suppresses anything. They described an
  // edit pass that was never built, and six of eleven expressions rendered a
  // neutral face under an emotional label because of them.
  const crying = expressiblePresets(vocab, [{ key: 'crying', blend_with: 'x', follow_on_pass: 'tears_inpaint' }]);
  assert.equal(crying.length, 1, 'a refinement hint is not a reason to skip prompting');
});

test('one answer to "which presets count", not three', () => {
  // expressionHint said 5, readiness said 7, uncalibratedPresets said 11, and
  // the picker offered all 11. See migration 053.
  const calib = src('src', 'services', 'studio', 'calibration.js');
  assert.match(calib, /async function expressible\(tenantId/);
  assert.match(calib, /const measurable = \(await expressible\(tenantId\)\)\.map/,
    'readiness asks the shared question');
  assert.match(calib, /const presets = await expressible\(tenantId\);/, 'and so does plan');

  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  assert.match(run, /const measurable = Calibration\.expressible;/,
    're-exported rather than re-implemented — a fourth copy is how this happened');

  const qc = src('src', 'services', 'studio', 'faceQc.js');
  assert.match(qc, /require\('\.\/calibration'\)\.expressible/);
  assert.ok(!/FROM expression_presets p\s*\n?\s*WHERE p\.tenant_id IS NULL AND p\.enabled/.test(qc),
    'the setup checklist must not list a preset nothing can generate — a line nobody can '
    + 'ever tick is worse than no checklist');

  // And nothing decides it from the blend columns any more.
  for (const f of [['src', 'services', 'studio', 'comfyui', 'buildWorkflow.js'],
                   ['src', 'services', 'studio', 'promptStage.js']]) {
    assert.ok(!/blend_with|follow_on_pass|expression_blend|expression_follow_on/.test(src(...f)),
      `${f[f.length - 1]} still reads a refinement hint as a precondition`);
  }
});

test('expression is a vocabulary facet like every other part of the prompt', () => {
  const wf = src('src', 'services', 'studio', 'comfyui', 'buildWorkflow.js');
  assert.match(wf, /expression:\s*fragment\(vocab, 'expression', shot\.expression_key \|\| 'neutral', \{ required: true \}\)/,
    'required, so a picker option the vocabulary does not define fails loudly at assembly '
    + 'instead of rendering a calm face');
  assert.ok(!/const light = \{/.test(wf), 'the hardcoded hint map is gone');
  assert.ok(!/function expressionHint/.test(wf));

  // Every preset the seed ships has a fragment, or the picker offers something
  // that cannot be generated.
  const mig = read(path.join(ROOT, 'src', 'db', 'migrations', '053_expression_vocabulary.sql'));
  const seed = read(path.join(ROOT, 'src', 'db', 'migrations', '030_studio_seed.sql'));
  // Scoped to the preset INSERT — the entitlements below it are also
  // `(NULL, '…'` rows, and matching them asked for an expression fragment for
  // "video_seconds".
  const from = seed.indexOf('INSERT INTO expression_presets');
  const block = seed.slice(from, seed.indexOf('INSERT INTO', from + 1));
  const presetKeys = [...block.matchAll(/\(NULL, '([a-z_]+)',/g)].map((m) => m[1]);
  assert.ok(presetKeys.length >= 11, `found ${presetKeys.length} presets — has the seed changed shape?`);
  for (const key of presetKeys) {
    assert.ok(mig.includes(`'expression', '${key}'`), `no expression fragment for "${key}"`);
  }

  // Version 1, not version 2: look_profiles pins vocabulary_version at setup,
  // so a new version strands every existing avatar on a vocabulary that cannot
  // express anything at all.
  assert.ok(!/VALUES\s*\n?\s*\(2, 'expression'/.test(mig));
  assert.match(mig, /\(1, 'expression', 'neutral'/);
});

// ── Pressing the button twice ────────────────────────────────────────────────

test('a second press costs nothing', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  assert.match(run, /idempotency_key: `calib:\$\{loraId\}:\$\{preset\.key\}:\$\{framing\}:\$\{sample\}`/,
    'keyed on the CELL and the sample, not on the run — a second press after a partial '
    + 'failure must re-use the frames that landed rather than buy the whole plan again');
  assert.ok(!/idempotency_key: `calib:\$\{run\}/.test(run));
});

test('a frame returns exactly what it cost, and nothing of its neighbours\'', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  const payload = run.slice(run.indexOf('payload: {'), run.indexOf('idempotency_key: `calib'));

  // No `_reserved`: calib_still is not in METERED, so no monthly counter was
  // touched and there is none to reconcile. That part has not changed.
  assert.ok(!/_reserved/.test(payload));

  // `_from_credits` there IS now — this frame's share of the run.
  assert.match(payload, /_from_credits: perJob \+ \(jobs\.length === 0 \? remainder : 0\)/,
    'whole credits with the remainder on the first job — dividing with a float leaks a '
    + 'fraction on every run, in our favour, which is the direction nobody reports');

  // And the failure path gives it back. Scoped to `failed()`, because
  // settlement names the stage elsewhere for the chain.
  const settle = src('src', 'services', 'studio', 'jobResult.js');
  const unhappy = settle.slice(settle.indexOf('async function failed('),
                               settle.indexOf('async function completed('));
  assert.ok(unhappy.length > 200, 'failed() moved — this assertion is reading nothing');
  // The GUARD ITSELF, both halves in one expression. Asserting the two pieces
  // separately passed while the permanence half was dropped — `job.status ===
  // 'failed'` also appears in the seed_still branch above, so it went on
  // matching somewhere else in the function while a requeued attempt got its
  // credits back and then ran again for free.
  assert.match(
    unhappy,
    /if \(job\.status === 'failed' && \['lora_train', 'calib_still'\]\.includes\(job\.stage\)\) \{/,
    'a permanently failed build must not stay charged, and a requeued one must not be '
    + 'refunded — it is going to run, and will cost again');
  const branch = unhappy.slice(unhappy.indexOf("if (job.status === 'failed' && ['lora_train'"));
  assert.match(branch.slice(0, branch.indexOf('\n  }')), /CreditLedger\.refund/,
    'and the refund is inside that guard, not beside it');
  assert.ok(/seed_still/.test(unhappy), 'and the seed refund it is modelled on is still there');
});

test('🐛 a second press does not buy frames that are already queued', () => {
  // The idempotency key protected the JOBS from duplication and the customer
  // from nothing: `enqueueTx` returns the existing row on conflict, so a second
  // press queued nothing, reported sixty-six job ids, and — the moment there
  // was a price — charged for all sixty-six again.
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  const submit = run.slice(run.indexOf('async function submit('));

  assert.match(submit, /const alive = new Map\(\)/);
  assert.match(submit, /if \(alive\.has\(`\$\{preset\.key\}:\$\{framing\}:\$\{sample\}`\)\) continue;/,
    'a frame already in flight is not work this press creates');
  assert.match(submit, /const frames = wanted\.length;/,
    'the charge is what will be BOUGHT, not the size of the plan');
  assert.ok(!/const frames = cells\.length \* samples;/.test(submit));

  // A frame that failed PERMANENTLY was refunded at settlement, so it is
  // genuinely outstanding — it must be re-queued and re-charged, which needs
  // its idempotency key released, exactly as a failed training run does.
  assert.match(submit, /\['failed', 'cancelled'\]\.includes\(j\.status\)/);
  assert.match(submit, /SET idempotency_key = NULL/,
    'otherwise the guard hands back the corpse and the retry is impossible');

  const training = src('src', 'services', 'studio', 'seedTraining.js');
  assert.match(training, /idempotency_key = NULL/, 'the pattern this is modelled on');
});

test('the whole run is paid for before any of it is queued', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  const submit = run.slice(run.indexOf('async function submit('));
  const spend = submit.indexOf('CreditLedger.spend');
  const enqueue = submit.indexOf('RenderJob.enqueueTx');
  assert.ok(spend > -1 && enqueue > spend,
    'charging cell by cell lets a customer run out at cell nine of eleven and keep a model '
    + 'that has most of a calibration — which cannot be activated, having spent the credits '
    + 'that would have finished it');
  assert.match(submit, /NOT_ENOUGH_CREDITS/);
  assert.match(submit, /status: 402/);

  // And the number spent is the rate card's, on the frames being bought.
  // Ordering alone passed while `credits` was quietly set to zero and the real
  // figure computed into a variable nobody read.
  assert.match(submit, /const credits = CreditLedger\.creditsFor\(CALIBRATION_METRIC, frames\);/);
  assert.match(submit, /CreditLedger\.spend\(\s*client, tenantId, CALIBRATION_METRIC, credits,/,
    'the charge passes that same number, not a recomputed one');
});

// ── The money, which is real even when the customer is not charged ───────────

test('the supplier cost is recorded even though nobody is billed', () => {
  const settle = src('src', 'services', 'studio', 'jobResult.js');
  assert.match(settle, /RenderJob\.complete\(existing\.id, workerId, \{\s*result, seconds_generated, megapixels, cost_cents,/,
    'cost_cents lands on every job whatever its stage, so SUM(cost_cents) WHERE '
    + "stage = 'calib_still' answers the self-hosting question");

  // And there is deliberately no usage counter for it.
  const usage = src('src', 'models', 'studioUsage.js');
  assert.ok(!/calib/.test(usage), 'a counter nobody enforces reads like a limit and is not');
});

// ── The half that is still not done ──────────────────────────────────────────

test('generating the frames is not the same as measuring them', () => {
  // `activate` must keep refusing until recordCell has actually run. Generating
  // 42 frames and calling that calibrated would put every future frame through
  // a baseline nothing measured.
  const training = src('src', 'services', 'studio', 'loraTraining.js');
  assert.match(training, /FROM expression_baselines WHERE lora_id = \$1/);
  assert.match(training, /NOT_CALIBRATED/);

  const calib = src('src', 'services', 'studio', 'calibration.js');
  assert.match(calib, /if \(!state\.ready\)/);
});

// ── The route ────────────────────────────────────────────────────────────────

test('there is an endpoint, because a command nobody can run is not a feature', () => {
  const routes = src('src', 'routes', 'studio.js');
  assert.match(routes, /post\('\/loras\/:id\/calibration\/run'/);
  const ctrl = src('src', 'controllers', 'studioAvatarController.js');
  assert.match(ctrl, /exports\.calibrationRun/);

  // The quote must describe the work that will actually be done.
  assert.match(ctrl, /CalibrationRun\.preview/,
    'Calibration.plan lists a cell for every enabled preset and the run will not queue the '
    + 'blended ones — a quote for work nobody does cannot be reconciled against the bill');

  // Six is the smallest sample that survives one structurally broken frame,
  // and recordCell refuses below five.
  const { MIN_SAMPLES } = require('../src/services/studio/calibration');
  assert.equal(MIN_SAMPLES, 5);
  assert.match(ctrl, /parseInt\(req\.body\?\.samples, 10\) \|\| 6, 6\)/);
});

// ── The chain, which has to run when nobody is watching ──────────────────────

test('settlement drives the next step, not a read', () => {
  const settle = src('src', 'services', 'studio', 'jobResult.js');
  const record = settle.slice(settle.indexOf('async function recordArtefacts('));
  assert.match(record, /CalibrationChain\.afterFrame\(done\)/,
    'a chain driven by a polling screen stops the moment the tab closes — which is not '
    + 'failed, not queued, just nothing, and reads as "still training" for 33 minutes');
  assert.match(record, /CalibrationChain\.afterEmbed\(done\)/);

  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.ok(!/setInterval|setTimeout/.test(chain), 'it is driven by events, not by a clock');
});

test('a cell is measured once, however many of its frames land together', () => {
  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.match(chain, /idempotency_key: `calibembed:\$\{loraId\}:\$\{presetKey\}:\$\{framing\}`/,
    'two frames of one cell settling in the same instant must queue one measurement');
});

test('the cell waits for all its frames, and does not wait for the dead ones', () => {
  const { SETTLED } = require('../src/services/studio/calibrationChain');
  assert.deepEqual([...SETTLED].sort(), ['cancelled', 'done', 'failed'],
    'a permanently failed frame is never coming, and waiting for it stalls the cell forever');

  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.match(chain, /if \(pending\.length\) return null;/,
    'the spread across a cell IS the measurement, so it needs all of them at once');
  // Per CELL, not per run: one slow cell must not hold up the other six.
  assert.match(chain, /payload->>'preset_key' = \$2/);
  assert.match(chain, /payload->>'framing'    = \$3/);
});

test('an embed job only writes into the baselines it was made for', () => {
  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.match(chain, /if \(!p\.calibration\) return null;/,
    'a seed-set check must never be written into somebody\'s baselines; the flag is on the '
    + 'payload rather than inferred from the shape of it');
  assert.match(chain, /calibration: true/);
});

test('a calibration cell expects unusable frames; a seed set does not', () => {
  const embed = src('worker', 'embedSeedSet.js');
  assert.match(embed, /const strict = job\.payload\?\.strict !== false;/,
    'strict is the DEFAULT — a seed set is what the customer is about to pay to train on');
  assert.match(embed, /if \(strict && unusable\.length\)/);
  assert.match(embed, /if \(!strict && !embeddings\.length\)/,
    'but zero usable frames is not a measurement whatever the mode');

  // Aligned per input frame, or a caller cannot tell six clean frames from
  // twelve frames half of which failed.
  assert.match(embed, /frames: measured/);
  assert.match(embed, /faces: Number\(out\.faces \|\| 0\)/,
    "recordCell reads `faces` to tell no_face from multiple_faces, and undefined !== 1 "
    + 'would file every one of them under the wrong reason');

  // And the vectors are not shipped twice for a seed set.
  assert.match(embed, /embedding: strict \? null : out\.embedding/);

  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.match(chain, /strict: false/);
});

test('a cell that could not be measured says so on the job', () => {
  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  const after = chain.slice(chain.indexOf('async function afterEmbed('));
  assert.match(after, /await note\(job\.id, \{ preset_key: p\.preset_key, framing: p\.framing,\s*error: err\.message/,
    'a screen that can only see readiness cannot tell "still working" from "this one needs '
    + 'more frames" — which is the shape of every "queued but nothing is happening" report');
  assert.match(chain, /result = result \|\| \$2::jsonb/, 'annotated, not overwritten');
});

test('advancing the chain can never undo the job that paid for it', () => {
  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  const bounds = { afterFrame: 'async function afterEmbed(', afterEmbed: 'async function note(' };
  for (const [fn, end] of Object.entries(bounds)) {
    const from = chain.indexOf(`async function ${fn}(`);
    const to = chain.indexOf(end);
    assert.ok(from > -1 && to > from, `${fn} moved — this assertion is reading the wrong text`);
    assert.match(chain.slice(from, to), /catch \(err\) \{[^]*console\.error/,
      `${fn} must swallow its own failure — recordArtefacts runs OUTSIDE the transaction on `
      + 'purpose, and a throw here would hand a completed job back to be paid for twice');
  }
  // Read unstripped: this one is about the comment that records the reason,
  // which is the only thing standing between the next person and moving
  // recordArtefacts back inside the transaction.
  const settle = read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js'));
  assert.match(settle, /Everything below is OUTSIDE the transaction on purpose/);
  assert.match(strip(settle), /await recordArtefacts\(existing, done, result, cost_cents\);/);
});

test('too few usable frames leaves the cell unmeasured rather than measuring noise', () => {
  const chain = src('src', 'services', 'studio', 'calibrationChain.js');
  assert.match(chain, /if \(frames\.length < Calibration\.MIN_SAMPLES\)/,
    'four frames would produce a tolerance from noise and then gate every future render with it');
  assert.ok(!/MIN_SAMPLES = |frames\.length < 5/.test(chain),
    'and the floor is read from the module that enforces it, not copied');
});

// ── The screen ───────────────────────────────────────────────────────────────

const FACE = ['..', 'frontend', 'app', 'avatars', '[id]', 'face', 'page.jsx'];

test('"Trained" is no longer a dead end', () => {
  const page = src(...FACE);
  const trained = page.slice(page.indexOf("<b>Trained</b>"), page.indexOf("if (run.abandoned)"));
  assert.match(trained, /<Calibration state=\{calibration\}/,
    'the copy told the person calibration decides the likeness thresholds and then offered '
    + 'them nothing to press — which is the same shape as every other dead end on this screen');
});

test('the screen reads rows, and never what a button returned', () => {
  const page = src(...FACE);
  const comp = page.slice(page.indexOf('function Calibration({'));
  assert.ok(comp.length > 500, 'the component moved — this assertion is reading nothing');

  // A state variable holding a POST's response is the bug this screen has had
  // four times: it says what it was told at the click and goes on saying it.
  assert.ok(!/useState\(null\)[^]*?setDone|const \[done/.test(comp),
    'nothing may be remembered from a press — every state is read from `state`');
  assert.match(comp, /await post\(path\);\s*onChanged\?\.\(\);/,
    'a press asks for a fresh read rather than rendering its own answer');
});

test('one read, not a second poll', () => {
  const training = src('src', 'services', 'studio', 'seedTraining.js');
  assert.match(training, /out\.calibration = await require\('\.\/calibrationRun'\)\.status/,
    'the face screen already polls trainStatus every three seconds; a second poll is a '
    + 'second thing to get wrong');
  assert.match(training, /if \(out\.versions > 0\)/, 'and nothing to say before a model exists');
});

test('progress is counted, not spun at', () => {
  const page = src(...FACE);
  const comp = page.slice(page.indexOf('function Calibration({'));
  assert.match(comp, /\{f\.done\} of \{f\.total\} photos/,
    '"Working…" for eight minutes is true, useless, and indistinguishable from broken');
  assert.match(comp, /className="track"/);
  assert.ok(!/className="meter"/.test(comp),
    '.meter is the sidebar frame — a top border, page padding and margin-top:auto — and '
    + 'borrowing it for a progress bar drags all three in');
});

test('the status says what is happening from rows alone', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  const st = run.slice(run.indexOf('async function status('));
  // Each state, AND what decides it. Asserting the literal alone passes on
  // `if (false) out.state = 'ready'` — a branch nothing can reach is the same
  // as a branch that is not there, and the screen would wait forever on a
  // model that is finished.
  const decides = {
    active:     /if \(lora\.active\) \{\s*out\.state = 'active'/,
    blocked:    /if \(!lora\.has_reference\) \{\s*out\.state = 'blocked'/,
    ready:      /if \(out\.ready\) out\.state = 'ready';/,
    working:    /else if \(out\.frames\.pending \|\| out\.measurements\.pending\) out\.state = 'working';/,
    none:       /else if \(out\.frames\.total === 0\) out\.state = 'none';/,
    incomplete: /else out\.state = 'incomplete';/,
  };
  for (const [name, re] of Object.entries(decides)) {
    assert.match(st, re, `the screen has a branch for "${name}" and nothing reachable sets it`);
  }
  assert.match(st, /age_seconds: Number\(fr\[0\]\.age_seconds \|\| 0\)/,
    'the stalled message counts with it — deriving `stalled` and leaving the number behind '
    + 'is how a screen ends up saying "queued for NaN"');
  assert.match(st, /out\.unmeasurable = em/,
    'a cell that failed is the difference between "still working" and "this one needs more frames"');
});

test('the customer is told what it costs in the unit they hold', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');

  // Asked of the rate card, never written here. The old hardcoded
  // `{ credits: 0, included: true }` was a price living in a service, which is
  // a price that disagrees with the rate card the moment either moves.
  assert.match(run, /credits: CreditLedger\.creditsFor\(CALIBRATION_METRIC, outstanding\)/);
  assert.ok(!/credits: 0, included: true/.test(run));

  // Priced on the cells still OUTSTANDING — a customer who lost two cells to
  // unusable frames is charged for two, not for eleven.
  assert.match(run, /const outstanding = ready\.missing\.length \* DEFAULT_SAMPLES;/);

  const page = src(...FACE);
  const comp = page.slice(page.indexOf('function Calibration({'));
  // A dollar amount, not any `$` — the file is full of template literals.
  assert.ok(!/\$\s*\d|\bcents\b|cost_cents|USD/.test(comp),
    "what fal charges us is an internal number; on a customer's button it quotes a "
    + 'supplier price and is not even what they would pay');
  assert.match(comp, /\$\{price\.credits\} credit/, 'credits are the unit a customer holds');
  assert.match(comp, /priceLabel \? ` — \$\{priceLabel\}` : ''/,
    'the price goes ON the button — nobody about to spend should read a paragraph to '
    + 'find out how many');
  assert.match(comp, /disabled=\{busy \|\| \(price && !price\.affordable\)\}/,
    'and a button that cannot be paid for does not invite the press');
});

test('the status quotes the same number the button will spend', () => {
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  assert.match(run, /const DEFAULT_SAMPLES = 6;/);
  // The read and the write must agree, or the price on screen is fiction.
  assert.match(run, /async function preview\([^)]*samples = DEFAULT_SAMPLES/);
  assert.match(run, /async function submit\([^)]*samples = DEFAULT_SAMPLES/);
  assert.ok(!/samples = 6[,)]/.test(run), 'six must not be written twice');

  // And it says how short they are, not merely that they are.
  assert.match(run, /out\.price\.short = Math\.max\(0, out\.price\.credits - out\.price\.held\);/);
  const page = src(...FACE);
  assert.match(page.slice(page.indexOf('function Calibration({')), /\{price\.short\} credits short/);
});

test('the product does not name its supplier', () => {
  const page = src(...FACE);
  const comp = page.slice(page.indexOf('function Calibration({'));
  assert.ok(!/\bfal\b/i.test(comp.replace(/false|fallback|failure|failed/gi, '')));
  const run = src('src', 'services', 'studio', 'calibrationRun.js');
  // The service may name it in a comment; the ERROR TEXT may not.
  for (const m of run.matchAll(/CalibrationError\(\s*'([^']*)'/g)) {
    assert.ok(!/fal/i.test(m[1].replace(/fall|fail/gi, '')), `customer-facing: ${m[1]}`);
  }
});

// ── The rule, not just this instance ─────────────────────────────────────────

test('every stage fal bills us for has a rate; nothing else does', () => {
  // The rule Raghav set: every step that spends our money at a supplier costs
  // the customer credits. Asserted against the PROVIDER's own endpoint table
  // rather than a list written here, so a stage added to fal without a price
  // fails this instead of shipping free.
  const { ENDPOINTS } = require('../worker/providers/fal');
  const { RATES } = require('../src/services/studio/credits');

  const RATE_FOR_STAGE = {
    still:       'still_megapixels',
    seed_still:  'still_megapixels',
    calib_still: 'lora_calibrations',
    lora_train:  'lora_trainings',
    motion:      'video_seconds',
  };

  for (const stage of Object.keys(ENDPOINTS)) {
    const metric = RATE_FOR_STAGE[stage];
    assert.ok(metric,
      `"${stage}" is billed by fal and this test does not know what it costs a customer — `
      + 'add it to the map above and give it a rate, or say why it is free');
    assert.ok(RATES[metric] > 0, `${stage} → ${metric} has no rate, so it is free to the customer`);
  }

  // And work that runs on our own hardware stays free — that absence is the
  // statement, not an omission.
  const { STAGES } = require('../src/controllers/studioJobController');
  for (const stage of ['embed', 'prompt', 'qc']) {
    assert.ok(STAGES.includes(stage));
    assert.ok(!(stage in ENDPOINTS), `${stage} must not be a fal stage`);
  }
  assert.ok(!('embed' in RATES), 'embedding costs the electricity of whatever laptop ran it');
});

test('a build is priced from the rate card, and the arithmetic is checked', () => {
  const { creditsFor } = require('../src/services/studio/creditLedger');
  const { DEFAULT_SAMPLES } = require('../src/services/studio/calibrationRun');

  // Eleven expressions at six samples is the default run.
  const frames = 11 * DEFAULT_SAMPLES;
  assert.strictEqual(frames, 66);

  const build = creditsFor('lora_trainings', 1) + creditsFor('lora_calibrations', frames);
  assert.strictEqual(build, 252, 'one avatar build');

  // Free holds 130 credits a month (100 video seconds + 15 MP at the seeded
  // entitlements). A build costs more than that, which is what now stops a free
  // account training a custom LoRA — the job `faces_claimed` was supposed to do
  // and never did, because nothing ever read it.
  const freeCredits = creditsFor('video_seconds', 100) + creditsFor('still_megapixels', 15);
  assert.strictEqual(freeCredits, 130);
  assert.ok(build > freeCredits,
    'pricing is the gate now; if a build ever costs less than the free month, free accounts '
    + 'can train custom LoRAs again and nothing else stops them');
});
