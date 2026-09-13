'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Training, as something the product does.
 *
 * It was `node studio/train.js --avatar 3 --yes` — a complete answer for the
 * person who owns the repository and none at all for anybody else. What stood
 * in the way was never the wiring: `requestTraining` refuses a seed set that is
 * not confidently one person, and that check needs a face embedding per image,
 * which comes from insightface through a Python subprocess. So the check became
 * a queued stage.
 */

// ── The stage ────────────────────────────────────────────────────────────────

test('embedding is a stage, and nobody bills for it', () => {
  const { STAGES, METERED } = require('../src/controllers/studioJobController');
  assert.ok(STAGES.includes('embed'), 'enqueue and claim have to agree on the vocabulary');
  assert.ok(!('embed' in METERED),
    'metering exists to bill what a provider charges, and nobody charges for this');
  // Checked at the source as well as through the re-export, so a meter added
  // where METERED actually lives cannot slip past.
  const settle = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));
  const table = settle.slice(settle.indexOf('const METERED = {'), settle.indexOf('async function inTransaction'));
  assert.ok(!/\bembed\s*:/.test(table), 'embed must not appear in the meter table');

  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /runner: 'mac'/,
    'it runs insightface on real hardware — the API host cannot be assumed to have Python');
  assert.ok(!/runner: 'cloud'/.test(svc.slice(svc.indexOf('async function check'), svc.indexOf('// ── 2.'))),
    'it is not a fal job');
});

test('there is one measurement, and it measures without judging', () => {
  // Two things run it — the API when its machine can embed, the worker when
  // another machine can — and neither may hold its own copy. Two copies of a
  // measurement is two answers to "is this one person", and the one that is
  // wrong is the one nobody re-reads.
  const fn = strip(read(path.join(ROOT, 'worker', 'embedSeedSet.js')));

  assert.ok(!/checkSeedCoherence|coherent/.test(fn),
    'where the threshold sits is a product decision; a runner that could decide a set was '
    + 'fine is a runner that could approve spending');
  assert.match(fn, /cost_cents: 0/, 'it costs the electricity of whatever machine ran it');
  assert.match(fn, /unusable\.push/, 'and it reports every unusable frame, not just the first');
  assert.match(fn, /faces > 1/, 'two faces means the mean drifts toward somebody who is not them');

  for (const caller of [['worker', 'index.js'], ['src', 'services', 'studio', 'embedRunner.js']]) {
    const src = strip(read(path.join(ROOT, ...caller)));
    assert.match(src, /embedSeedSet/, `${caller.join('/')} must use the shared measurement`);
    assert.ok(!/async function runEmbed/.test(src), `${caller.join('/')} keeps its own copy`);
  }

  // It lives under worker/ for the same reason stageKinds has no requires: the
  // render worker must not be able to reach the database, so what it imports
  // must not pull config/db in behind it.
  assert.ok(!/config\/db/.test(fn));

  const wk = strip(read(path.join(ROOT, 'worker', 'index.js')));
  assert.match(wk, /if \(job\.stage === 'embed'\)/, 'not a render, so not a provider dispatch');
  assert.match(wk, /claimEmbed/);
  assert.match(wk, /runner=mac&stages=embed/);
  assert.match(wk, /if \(!claimed && CONFIG\.embed\)/,
    'asked second: a person watching a batch land outranks one waiting on a check');
});

test('the API checks seed sets itself when its machine can', () => {
  // The `embed` stage put back the separate process that moving fal renders
  // in-process had just removed — for one step, whose failure mode is silence.
  // The concern that made it a worker was real (Python and insightface are not
  // on every host) but it is a QUESTION, with the same answer as FAL_KEY: ask,
  // and act on what is true here.
  const app = strip(read(path.join(ROOT, 'src', 'app.js')));
  assert.match(app, /EmbedRunner/);
  assert.match(app, /STUDIO_EMBED_RUNNER !== 'off'/);
  const ready = app.indexOf('EmbedRunner.ready()');
  const start = app.indexOf('EmbedRunner.start()');
  assert.ok(ready > -1 && start > -1 && ready < start,
    'capability is asked before the loop is started');

  const run = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'embedRunner.js')));
  assert.match(run, /runner: 'mac', stages: \['embed'\]/);
  assert.match(run, /if \(!\(await this\.ready\(\)\)\) return null/,
    'a machine that cannot embed must claim nothing, so the job waits for one that can');

  // Probing by importing, not by looking for a binary: python3 exists nearly
  // everywhere and insightface almost nowhere. Asserted on the ARGUMENTS —
  // matching the flag anywhere in the file is satisfied by the comment that
  // explains it, which is how it stayed green with the flag removed.
  assert.match(run, /execFile\(python, \[script, '--probe'\]/);
  // In the OPTIONS, not merely declared somewhere above. Matching the constant
  // by name is satisfied by the `const` that defines it, with the option gone.
  assert.match(run, /\{ timeout: PROBE_TIMEOUT_MS \}/,
    'a probe that can hang is a boot that can hang');
  const py = read(path.join(ROOT, 'worker', 'faceEmbed.py'));
  assert.match(py, /def probe\(\)/);
  assert.match(py, /import insightface/);
  assert.ok(!/load_model\(\)/.test(py.slice(py.indexOf('def probe()'), py.indexOf('if __name__'))),
    'the probe must not load the model — it runs on every boot');
});

test('the probe answers with the reason, not with the shape of the failure', async () => {
  const { probe } = require('../src/services/studio/embedRunner');

  // The probe exits 1 when it cannot import AND prints why. Reading execFile's
  // error first would report "Command failed: python3 …/faceEmbed.py --probe",
  // which is the shape of the failure and none of its substance.
  const missingModule = await probe();
  assert.strictEqual(missingModule.ok, false);
  assert.match(missingModule.error, /insightface|numpy/,
    'a person can act on a missing module; they cannot act on "command failed"');

  const missingPython = await probe({ python: 'python-that-is-not-there' });
  assert.strictEqual(missingPython.ok, false);
  assert.match(missingPython.error, /no such interpreter/);
});

// ── The set cannot move underneath it ────────────────────────────────────────

test('a measurement belongs to the exact set it measured', () => {
  const { fingerprint } = require('../src/services/studio/seedTraining');

  // Order must not matter; content must.
  assert.strictEqual(fingerprint(['b.png', 'a.png']), fingerprint(['a.png', 'b.png']));
  assert.notStrictEqual(fingerprint(['a.png', 'b.png']), fingerprint(['a.png', 'c.png']));
  assert.notStrictEqual(fingerprint(['a.png']), fingerprint(['a.png', 'b.png']));
  assert.strictEqual(fingerprint([]).length, 32);

  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  const submit = svc.slice(svc.indexOf('async function submit'));

  // The guards, not just their messages. A refusal that is still WRITTEN but no
  // longer REACHED reads identically in the source and does nothing at all.
  assert.match(submit, /if \(job\.payload\?\.set_fingerprint !== set\.fingerprint\) \{[\s\S]{0,300}SET_CHANGED/,
    'training on a stale measurement writes a reference from photos nobody kept');
  assert.match(submit, /if \(!job \|\| job\.status !== 'done'\) \{[\s\S]{0,200}NOT_CHECKED/);
  assert.match(submit, /embeddings\.length !== set\.kept\.length[\s\S]{0,200}CHECK_MISMATCH/);

  // And each one refuses rather than logging. Matched as ONE construct: looking
  // backwards from the code for a nearby `throw` finds the previous guard's
  // throw and passes while this guard has been turned into a console.warn.
  for (const code of ['SET_CHANGED', 'NOT_CHECKED', 'CHECK_MISMATCH']) {
    assert.match(submit, new RegExp(`throw new TrainingRefused\\([^;]*${code}`),
      `${code} must refuse, not warn`);
  }
  assert.ok(!/console\.(warn|log)\(/.test(submit),
    'nothing here is worth only a log line — every refusal has to reach the caller');

  // Re-read rather than trusting what the screen was showing: a screen can be
  // stale and a request can be replayed.
  assert.ok(submit.indexOf('keptSet(client') < submit.indexOf('requestTraining'),
    'the gate is re-applied at submit, not assumed from the check');
});

test('confirming twice does not spend a second avatar slot', () => {
  // `requestTraining` carries an idempotency key, which stops a second ROW but
  // not a second RESERVATION: it spends an avatar when the version is 1, and
  // the version comes from `avatar_loras`, which is not written until the job
  // COMPLETES. Measured — the second press failed with "Not enough avatars
  // remaining" on a workspace that had spent nothing.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  const submit = svc.slice(svc.indexOf('async function submit'));

  const guard = submit.indexOf('WHERE idempotency_key = $1 AND tenant_id = $2');
  const call  = submit.indexOf('LoraTraining.requestTraining');
  assert.ok(guard > -1 && call > -1, 'both the guard and the call must be present');
  assert.ok(guard < call, 'the question is asked before anything is reserved');
  assert.match(submit, /already_submitted: true/);
});

// ── The screen ───────────────────────────────────────────────────────────────

test('the button checks and prices before it spends', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));

  // Pressing "Use these photos" measures. It does not train.
  assert.match(page, /post\(`\/avatars\/\$\{avatarId\}\/train\/check`\)/);
  const train = page.slice(page.indexOf('async function train()'), page.indexOf('if (!candidates.length'));
  assert.ok(!/post\(`\/avatars\/\$\{avatarId\}\/train`/.test(train),
    'the first press must not be the one that spends');

  assert.match(page, /function TrainPanel/);
  assert.match(page, /state\?\.price/, 'what it costs is on the button before it is pressed');

  // …and the server actually sends it. A screen that reads a field nobody sets
  // renders nothing where a price should be, which is the failure this whole
  // two-press flow exists to avoid.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /price: \{/);
  assert.match(svc, /credits: CreditLedger\.creditsFor/);
  assert.match(page, /state\.coherence\.outliers\.map/, 'and the outliers are named');
  assert.match(page, /check\?\.stalled/,
    'an embed job needs a worker running, which is exactly the silence worth breaking');
});

test('the three endpoints are ordered so neither shadows the other', () => {
  const routes = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  const check = routes.indexOf("'/avatars/:id/train/check'");
  const get   = routes.indexOf("router.get ('/avatars/:id/train'");
  const post  = routes.indexOf("router.post('/avatars/:id/train'");
  assert.ok(check > -1 && get > -1 && post > -1, 'all three must be registered');
  assert.ok(check < post,
    'both are four segments and Express takes the first that matches — /train would eat /train/check');

  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  assert.match(ctl, /res\.set\('Cache-Control', 'no-store'\)/,
    'the status is polled while a check runs and reports a number that is changing');
  assert.ok(!/seed_embeddings/.test(ctl),
    'nothing outside this system should be handing us embeddings');
});

test('a customer is quoted in credits, never in what fal charges us', () => {
  // "$2.00" on the Train button is our SUPPLIER's price. It belongs on the job
  // as cost_cents, where the self-hosting decision is read out of it, and on
  // the admin screens — not on a customer's button, where it invites arithmetic
  // about our margin and is not even the number they would pay.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.ok(!/price_cents/.test(page), 'cents must not reach the screen at all');
  assert.ok(!/\$\$\{/.test(page), 'nor a dollar sign in front of one');
  assert.match(page, /\$\{price\.credits\} credit/, 'credits are the unit a customer holds');

  // And nothing else customer-facing quotes a cost either.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'admin') return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.jsx') ? [full] : []);
  });
  for (const f of walk(path.join(FE, 'app'))) {
    assert.ok(!/cost_cents|price_cents/.test(read(f)),
      `${path.relative(FE, f)} shows a supplier cost to a customer`);
  }

  // The service asks the rate card rather than hardcoding, so pricing training
  // later needs no edit here.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /credits: CreditLedger\.creditsFor\(TRAINING_METRIC, 1\)/);
  assert.ok(!/price_cents/.test(svc));

  // And the rate card prices it. It used to be absent — "training is what an
  // avatar IS, charging again is charging twice" — which did not survive the
  // arithmetic: a run is ₹200 of supplier cost, retraining was unbounded, and
  // nothing counted cycles.
  const { RATES } = require('../src/services/studio/credits');
  const { creditsFor } = require('../src/services/studio/creditLedger');
  assert.ok('lora_trainings' in RATES, 'every step that spends our money costs credits');
  assert.ok(creditsFor('lora_trainings', 1) > 0);

  // Spent where the job is enqueued, in the SAME transaction, or there is an
  // instant where the credits are gone and no job exists.
  const training = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'loraTraining.js')));
  assert.match(training, /CreditLedger\.spend\(\s*client, tenantId, 'lora_trainings'/);
  assert.match(training, /NOT_ENOUGH_CREDITS/, 'and a refusal that says how short they are');
  assert.match(training, /_from_credits: trainingCredits/,
    'recorded on the payload, because that is what the refund path reads');

  // The cost still exists where it belongs — the worker bills the finished job.
  const fal = strip(read(path.join(ROOT, 'worker', 'providers', 'fal.js')));
  assert.match(fal, /FAL_PRICE_LORA_TRAIN_CENTS/);
  const L = require('../src/services/studio/loraTraining');
  assert.strictEqual(typeof L.trainingPriceCents(), 'number');
});

test('the button says what it will do, whichever the rate card says', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const src = page.match(/const priceLabel = [\s\S]*?: null;/);
  assert.ok(src, 'the label must be one expression');
  const label = new Function('price', `const state = { price }; ${src[0]} return priceLabel;`);

  assert.strictEqual(label({ credits: 0, included: true }), null, 'included: no number at all');
  assert.strictEqual(label({ credits: 40, included: false }), '40 credits');
  assert.strictEqual(label({ credits: 1, included: false }), '1 credit', 'and it counts properly');
  assert.strictEqual(label(undefined), null, 'a status that has not arrived says nothing');

  assert.match(page, /priceLabel \? `Train — \$\{priceLabel\}` : 'Train'/);
  assert.match(page, /It is included with this avatar, and so is retraining/);
});

test('a stalled check says which of the two things is wrong', () => {
  // "Nothing has started the check" is the symptom the screen is already
  // showing. The two causes need different sentences: this server cannot
  // measure faces at all, or it can and something else is wrong.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /out\.check\.can_measure_here = await EmbedRunner\.ready\(\)/);
  assert.match(svc, /why_not/);

  // Only when something has actually gone quiet: a healthy poll must not spawn
  // a subprocess every few seconds.
  const guard = svc.indexOf('if (out.check.stalled)');
  const asked = svc.indexOf('EmbedRunner.ready()');
  assert.ok(guard > -1 && asked > -1 && guard < asked);

  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /check\.can_measure_here === false/);
  assert.match(page, /STUDIO_EMBED_RUNNER/, 'and the other branch names the switch');
});

test('an inline message reaches the app it is used in', () => {
  // `.lp-msg` was defined only in landing.css, which the app layout does not
  // import — so eight screens had no background, no border and, because the
  // column layout lives in the same rule, no line break. The training panel
  // rendered "Nothing has started the checkIt has been queued for 3:03".
  const globals = read(path.join(FE, 'app', 'globals.css'));
  const rule = globals.match(/^\.lp-msg\s*\{([^}]*)\}/m);
  assert.ok(rule, '.lp-msg must be styled where the app can see it');
  assert.match(rule[1], /flex-direction: column/, 'the fact and its explanation are two lines');
  assert.match(rule[1], /padding:/);
  for (const kind of ['crit', 'warn', 'ok']) {
    assert.match(globals, new RegExp(`^\\.lp-msg\\.${kind}\\s*\\{[^}]*background:`, 'm'),
      `.lp-msg.${kind} needs a ground to sit on`);
  }

  // The app layout imports globals.css and not landing.css, which is the whole
  // reason this had to move.
  const layout = read(path.join(FE, 'app', 'layout.jsx'));
  assert.match(layout, /globals\.css/);
  assert.ok(!/landing\.css/.test(layout));
});

// ── One avatar, counted once ─────────────────────────────────────────────────

test('training does not charge for the avatar it is training', () => {
  // The `avatars` lifetime entitlement was reserved TWICE for one avatar: at
  // creation, and again when its first LoRA was requested. Training reserved it
  // first, historically, back when an avatar was only counted once it had a
  // model; creation then started reserving too and nobody removed the older one.
  //
  // On a one-avatar plan every customer hit it at the worst possible moment:
  // create the avatar, spend the slot, cull a set, press Train, and be told
  // "Not enough avatars remaining: asked for 1, 0 left of 1" about the avatar
  // they already own, at the point of paying.
  const lora = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'loraTraining.js')));
  assert.ok(!/reserve\([^)]*'avatars'/.test(lora),
    'requesting a model must not spend an avatar — having one already did');
  assert.ok(!/StudioUsage/.test(lora),
    'and with that gone there is nothing left for it to meter');

  // Creation is where it belongs: the cap is a statement about how many avatars
  // you may HAVE, and one exists from the moment it is created.
  const create = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  assert.match(create, /StudioUsage\.reserve\(client, req\.user\.tenant_id, 'avatars', 1, 'lifetime'/);
});

test('the repair sets the counter to the real number of avatars', () => {
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '051_avatar_counted_once.sql'));
  const ddl = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  // Not a decrement. Subtracting one per trained avatar assumes the exact
  // history that produced each row, and the histories differ — avatars made
  // before creation reserved, avatars made by load-persona.js which reserves
  // nothing, avatars deleted after being counted.
  assert.ok(!/used\s*=\s*used\s*-/.test(ddl), 'a decrement guesses at a history nobody has');
  assert.match(ddl, /SET used = t\.n/);
  assert.match(ddl, /SELECT tenant_id, COUNT\(\*\)::numeric AS n\s*\n?\s*FROM avatars/);
  // EVERY update scoped to the lifetime row, not just one of them. Matching the
  // clause anywhere is satisfied by the second statement while the first has
  // been let loose on every period this workspace has ever had.
  const updates = ddl.match(/UPDATE studio_usage_counters/g) || [];
  const scoped = ddl.match(/period_start = DATE '1970-01-01'/g) || [];
  assert.ok(updates.length >= 2, `expected both repairs, found ${updates.length}`);
  assert.strictEqual(scoped.length, updates.length,
    "every statement must be scoped to the lifetime row — that is how 'lifetime' is spelled");
  const metric = ddl.match(/metric = 'avatars'/g) || [];
  assert.strictEqual(metric.length, updates.length, 'and to the avatars meter alone');

  // A workspace whose avatars were all deleted has nothing to join to, and must
  // still read zero rather than whatever it last was.
  assert.match(ddl, /NOT EXISTS \(SELECT 1 FROM avatars a WHERE a\.tenant_id = c\.tenant_id\)/);
  assert.match(ddl, /SET used = 0/);
});

// ── After the button ─────────────────────────────────────────────────────────

test('the run is watched, not announced once and abandoned', () => {
  // It said "Training queued as version 1" and then said that forever — whether
  // the run was working, finished, or had failed twenty seconds later. The same
  // dead end a queued candidate batch used to be: the answer to "is anything
  // happening" has to come from the job row, not from a request that once
  // succeeded.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /stage = 'lora_train' AND tenant_id = \$1 AND payload->>'avatar_id' = \$2/);

  // Scoped to the block that builds it, and the block has to be REACHED. Every
  // field name here also appears on `gate` or `check`, so asserting them
  // against the whole file passes with this block behind `if (false)`.
  assert.match(svc, /if \(runs\[0\]\) \{/, 'the run is reported when there is one');
  const from = svc.indexOf('out.training = {');
  assert.ok(from > -1, 'the training block must exist');
  const block = svc.slice(from, svc.indexOf('};', from));
  for (const field of ['job_id', 'version', 'status', 'error', 'attempts', 'running_seconds', 'stalled']) {
    assert.match(block, new RegExp(`\\b${field}:`), `the screen needs ${field}`);
  }
  assert.match(block, /stalled: Number\(run\.ever_claimed\) === 0 && Number\(run\.age_seconds \|\| 0\) > 120/,
    'a run nothing has claimed must not read as one that is working');
  assert.match(block, /error: run\.error \|\| null/);

  // `trained` was initialised false and never computed.
  assert.match(svc, /out\.trained = loras\[0\]\.active > 0/);
  assert.match(svc, /COUNT\(\*\) FILTER \(WHERE active\)/);

  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /function TrainingRun/);
  assert.match(page, /done \|\| state\?\.training \?/,
    'the live row takes over from the response as soon as there is one');

  // Every state it can actually be in.
  for (const state of [/run\.status === 'failed'/, /run\.status === 'done'/, /run\.stalled/]) {
    assert.match(page, state, `unhandled run state: ${state}`);
  }
  assert.match(page, /run\.error \|\| 'No reason was recorded\.'/,
    'a failure has to say why, or it is the same dead end with red text');
});

test('coming back to watch does not queue a second check', () => {
  // The only way back to a run in progress was the button that starts one.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  // Sliced FORWARDS. `undo` is declared above `train`, so using it as the end
  // marker gave indexOf a smaller number than the start and an empty string —
  // which failed loudly here, and would have passed silently on any assertion
  // written with `doesNotMatch`.
  const from = page.indexOf('async function train()');
  assert.ok(from > -1, 'train() must be findable');
  const fn = page.slice(from, page.indexOf('// Nothing to cull yet', from));
  assert.ok(fn.length > 100, 'and the slice must actually contain it');

  const look = fn.indexOf('await get(`/avatars/${avatarId}/train`)');
  const queue = fn.indexOf('post(`/avatars/${avatarId}/train/check`)');
  assert.ok(look > -1 && queue > -1, 'both the look and the queue must be present');
  assert.ok(look < queue, 'it has to look before it queues');
  assert.match(fn, /if \(!busy\) await post/);
  assert.match(fn, /\['queued', 'claimed', 'running', 'done'\]\.includes\(now\.training\.status\)/);
});

// ── Who we buy from is not the customer's business ───────────────────────────

/**
 * Strip the blocks that only staff ever see.
 *
 * `{user?.role === 'admin' && ( … )}` is the ops surface: the person reading it
 * is the person who sets the env var, and naming the exact variable is the
 * whole value of the sentence. Everything OUTSIDE those blocks is a customer's
 * screen, and a customer has no business being told who we buy from.
 */
function customerVisible(src) {
  const MARK = "user?.role === 'admin' && (";
  let out = '';
  let i = 0;
  for (;;) {
    const at = src.indexOf(MARK, i);
    if (at === -1) { out += src.slice(i); return out; }
    out += src.slice(i, at);
    // Walk to the paren that closes the block.
    let depth = 0;
    let j = at + MARK.length - 1;
    for (; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    i = j + 1;
  }
}

test('no screen names a supplier to a customer', () => {
  // "It runs on fal and takes roughly twenty minutes." A customer does not need
  // to know who renders their photos, and telling them names the company they
  // could go to directly. Same rule as the price: the supplier is ours.
  const SUPPLIERS = [/\bfal\b/i, /fal\.ai/i, /insightface/i, /\bflux\b/i,
                     /seedance/i, /comfyui/i, /\bpulid\b/i, /arcface/i];

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'admin') return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.jsx') ? [full] : []);
  });

  const files = [...walk(path.join(FE, 'app')), ...walk(path.join(FE, 'components'))];
  assert.ok(files.length > 10, `expected a real tree, found ${files.length}`);

  for (const f of files) {
    const visible = customerVisible(read(f));
    for (const re of SUPPLIERS) {
      const hit = visible.match(re);
      assert.ok(!hit, `${path.relative(FE, f)} says "${hit?.[0]}" where a customer can read it`);
    }
  }

  // The stripper has to actually strip, or this test passes by doing nothing.
  const sample = "a {user?.role === 'admin' && (<>only staff see fal here</>)} b";
  assert.strictEqual(customerVisible(sample), 'a {} b');
  assert.match(customerVisible('plain fal text'), /fal/, 'and it must not strip everything');
});

test('staff still get told which key and which package', () => {
  // The other half of the rule. An admin reading "this server is not configured
  // to render" cannot act on it; "it holds no fal key" is the whole sentence.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const staffOnly = page.length - customerVisible(page).length;
  assert.ok(staffOnly > 200, 'the admin diagnostics must still exist');

  // Per component, not across the file. Two different screens stall for the
  // same reason — a candidate batch and a training run — so asserting the
  // phrase anywhere is satisfied by one of them while the other has gone quiet.
  const componentOf = (name) => {
    const from = page.indexOf(`function ${name}(`);
    assert.ok(from > -1, `${name} must exist`);
    const next = page.indexOf('\nfunction ', from + 1);
    return page.slice(from, next === -1 ? page.length : next);
  };

  for (const name of ['Arriving', 'TrainingRun']) {
    const admin = componentOf(name).split("user?.role === 'admin' && (").slice(1).join('\n');
    assert.ok(admin.length > 0, `${name} must keep its staff diagnostic`);
    assert.match(admin, /fal key/i, `${name} must name the key an admin has to set`);
  }
  assert.match(componentOf('TrainPanel'), /insightface/i,
    'and the package they have to install');
});

// ── Abandoned work ───────────────────────────────────────────────────────────

test('🐛 something actually reaps expired leases now', () => {
  // `RenderJob.reapExpiredLeases` was correct from the day it was written and
  // NOTHING EVER CALLED IT. The only caller was an HTTP endpoint commented
  // "safe to call on a timer" that no timer invoked.
  //
  // The whole lease design rests on it — claiming takes a lease, long renders
  // heartbeat to extend it, LEASE_LOST is a code workers handle — and with
  // nothing expiring anything, all of that was ceremony. A training run held by
  // the API process, the API restarted for a migration, and the job sat
  // `running` with a frozen lease while the screen counted past the twenty
  // minutes it had promised.
  const app = strip(read(path.join(ROOT, 'src', 'app.js')));
  assert.match(app, /Reaper\.start\(\)/, 'the reaper has to be started by something');
  assert.match(app, /STUDIO_REAPER !== 'off'/);
  assert.match(app, /NODE_ENV !== 'test'/);

  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'reaper.js')));
  assert.match(svc, /RenderJob\.reapExpiredLeases\(\)/);
  assert.match(svc, /setTimeout\(loop/, 'on a timer, not once at boot');
  assert.match(svc, /console\.error\('\[studio\/reaper\]'/,
    'a reaper that dies on one bad query strands every future job');
  assert.match(svc, /if \(this\._timer\) return this\._timer/, 'and it must not start twice');

  // Often enough to beat a person's patience, rarely enough to be free. The
  // shortest lease anyone takes is 30s.
  const { DEFAULTS } = require('../src/services/studio/reaper');
  assert.ok(DEFAULTS.everyMs >= 5_000 && DEFAULTS.everyMs <= 3_600_000, 'clamped');
  assert.ok(DEFAULTS.everyMs <= 120_000, 'a dead worker must be found within about a lease');
});

test('a job nobody is working on stops looking like one that is', () => {
  // From the outside they are identical: the row says `running` either way.
  // `stalled` only ever covered NEVER claimed, so a job whose holder died was
  // invisible to it.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /\(lease_expires_at IS NOT NULL AND lease_expires_at < NOW\(\)\) AS lease_expired/);
  assert.match(svc, /abandoned: run\.lease_expired === true && \['claimed', 'running'\]\.includes\(run\.status\)/,
    'a finished job with a stale lease is not abandoned — it is finished');

  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /if \(run\.abandoned\)/);
  assert.match(page, /Picking it up again/);
  assert.match(page, /run\.attempts >= 3/, 'and the last attempt says it is the last');

  // It has to be checked BEFORE the stalled branch, which it would fall through.
  const fn = page.slice(page.indexOf('function TrainingRun'));
  assert.ok(fn.indexOf('run.abandoned') < fn.indexOf('run.stalled'));
});

test('the screen stops promising twenty minutes at thirty-three', () => {
  // Repeating the estimate is the screen insisting on something the person can
  // see is not true.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const fn = page.slice(page.indexOf('function TrainingRun'));
  assert.match(fn, /\(run\.running_seconds \|\| 0\) > 25 \* 60/);
  assert.match(fn, /longer than usual/);
  assert.match(fn, /goes back on the queue by itself/,
    'and says why waiting is safe, now that it actually is');
});

// ── Retrying a failed run ────────────────────────────────────────────────────

test('🐛 a failed run can actually be submitted again', () => {
  // The panel said "press Train again once the cause is fixed" and pressing it
  // would have returned the same failure forever. The key identifies a
  // submission, `enqueueTx` is ON CONFLICT DO NOTHING and then re-selects, and
  // the already-submitted guard handed back whatever it found — including a
  // corpse. The only way out was unpicking a frame to change the fingerprint.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  const submit = svc.slice(svc.indexOf('async function submit'));

  assert.match(submit, /if \(prior && !\['failed', 'cancelled'\]\.includes\(prior\.status\)\)/,
    'only a run that is alive, or that produced a model, IS this submission');
  assert.match(submit, /UPDATE render_jobs SET idempotency_key = NULL[^;]*WHERE id = \$1/,
    'a failed run is finished with its key, and holding it blocks every retry');

  // On the POOL, not on the caller's transaction. `requestTraining` opens its
  // own connection, so an UPDATE held uncommitted here is invisible to it — its
  // INSERT blocks on the still-live unique index, waiting for a transaction
  // that is waiting for it. Measured: `submit` never returned.
  assert.match(submit, /await pool\.query\(\s*\n?\s*'UPDATE render_jobs SET idempotency_key = NULL/,
    'releasing the key inside the caller transaction deadlocks against requestTraining');
  const lora = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'loraTraining.js')));
  // Scoped to the function, not to an arbitrary window: 900 characters happened
  // to fall two short of the line, which is the kind of number that is right
  // until somebody adds a comment.
  const from = lora.indexOf('async requestTraining');
  const next = lora.indexOf('\n  async ', from + 1);
  const rt = lora.slice(from, next === -1 ? lora.length : next);
  assert.match(rt, /pool\.connect\(\)/,
    'which is only a hazard because requestTraining takes its own connection');
  assert.ok(!/requestTraining\([^)]*client/.test(rt.slice(0, 200)),
    'and it does not accept one, which is what makes this the caller\'s problem');

  // Released rather than reused, so the retry is a NEW row with its own attempt
  // budget — which is the whole point after "no attempts remain".
  const release = submit.indexOf('idempotency_key = NULL');
  const enqueue = submit.indexOf('requestTraining');
  assert.ok(release > -1 && enqueue > -1 && release < enqueue,
    'the key has to be freed before the insert that would collide with it');
});

test('the failed panel offers the button its own sentence names', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const fn = page.slice(page.indexOf('function TrainingRun'));
  const failed = fn.slice(fn.indexOf("run.status === 'failed'"), fn.indexOf("run.status === 'done'"));

  assert.match(failed, /onClick=\{onRetry\}/, 'a dead end with red text is still a dead end');
  assert.match(failed, /Train again/);
  assert.match(failed, /disabled=\{busy\}/);
  assert.ok(!/press Train again once the cause is fixed/.test(failed),
    'copy must not name a control that is not there');

  // And it is wired to the thing that submits.
  assert.match(page, /onRetry=\{confirm\}/);
});

test('pressing it does not leave the old failure on screen', () => {
  // The live row wins over the response, so a retry would go on saying
  // "Training failed" for three seconds — directly underneath the button that
  // had just worked.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const confirmFn = page.slice(page.indexOf('async function confirm()'),
                               page.indexOf('const check = state?.check'));
  assert.match(confirmFn, /setDone\(await post/);
  assert.match(confirmFn, /onSubmitted\?\.\(\)/);
  assert.ok(confirmFn.indexOf('setDone') < confirmFn.indexOf('onSubmitted'),
    'the new job first, then drop the answer that describes the old one');

  assert.match(page, /onSubmitted=\{\(\) => setTrainState\(null\)\}/);
});

test('🐛 a finished job is not the same as a model', () => {
  // The version on screen comes off the JOB's payload — the number the run was
  // going to write — not off a row in `avatar_loras`. Recording happens after
  // the job completes and OUTSIDE its transaction, deliberately, so a failure
  // there leaves a run that succeeded, cost money and produced nothing
  // findable. It has happened here: calibration once reported "no trained
  // LoRAs" about a run that worked and billed.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const fn = page.slice(page.indexOf('function TrainingRun'));
  const done = fn.slice(fn.indexOf("run.status === 'done'"), fn.indexOf('if (run.stalled)'));

  assert.match(done, /if \(versions === 0\)/, 'the screen must count models, not jobs');
  assert.match(done, /no model was saved/i);
  assert.match(done, /onClick=\{onRetry\}/, 'and offer the only thing that helps');

  // The count has to reach it.
  assert.match(page, /versions=\{state\?\.versions\}/);
  // That it RECEIVES the count, not the exact shape of the parameter list — a
  // signature pinned literally goes red the next time a prop is added beside
  // it, which says nothing about whether the screen still counts models.
  assert.match(page, /function TrainingRun\(\{[^}]*\bversions\b[^}]*\}\)/);

  // And it is a real count of rows, not the job's own idea of its version.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedTraining.js')));
  assert.match(svc, /out\.versions = loras\[0\]\.n/);
  assert.match(svc, /COUNT\(\*\)::int AS n\s*\n?\s*FROM avatar_loras|COUNT\(\*\)::int AS n,/);
});
