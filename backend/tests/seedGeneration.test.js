'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

process.env.STUDIO_STORAGE_SECRET = process.env.STUDIO_STORAGE_SECRET || 'test-secret';
const Prompt = require('../src/services/studio/seedPrompt');
const Seed   = require('../src/services/studio/seedCandidates');

/**
 * Generating a candidate pool from the product, not from a terminal.
 *
 * The face screen used to print `npm run studio:seed-set` — a developer
 * instruction on a customer-facing page, for a customer with no repository, no
 * GPU and no terminal. The commands were there because the button was not, and
 * the button was not there because a candidate pool is the one render that
 * happens BEFORE a LoRA exists, and every still path refuses without one.
 */

// ── The grid ─────────────────────────────────────────────────────────────────

test('any 24 consecutive frames cover the whole export gate', () => {
  // The nesting order is the load-bearing part: framing, angle and light are
  // the innermost loops. Walk them outermost and the first 24 frames are all
  // close/front, the first 72 all close, and a batch that stops early — or a
  // customer who could only afford 24 — covers nothing.
  const cells = Prompt.cells();
  const gateCells = new Set(cells.map(Prompt.cellKey));
  assert.strictEqual(gateCells.size, 18, 'three framings x three angles x two lights');

  for (const start of [0, 24, 100, 191]) {
    const window = cells.slice(start, start + 24).map(Prompt.cellKey);
    assert.strictEqual(new Set(window).size, 18,
      `frames ${start}-${start + 24} miss ${18 - new Set(window).size} gate cells`);
  }
});

test('a second batch fills the thin cells rather than restarting the walk', () => {
  // Topping up a pool that is short on profiles must not produce more front-on
  // frames.
  const have = new Map([['close|front|soft', 9], ['close|front|hard', 9]]);
  const ordered = Prompt.orderCells(have);
  const first = Prompt.cellKey(ordered[0]);
  assert.notStrictEqual(first, 'close|front|soft');
  assert.ok(ordered.findIndex((c) => Prompt.cellKey(c) === 'close|front|soft') > 100,
    'an already-full cell must sink to the back');
});

test('the prompt carries the identity block first and no trigger token', () => {
  const plan = Prompt.plan({
    avatar: { identity_block: '52 year old Kashmiri man,  light brown skin' },
    look: { base_look: 'editorial', lens: 'portrait_85' },
    vocab: { base_look: { editorial: 'editorial lighting' } },
    count: 2,
  });
  assert.ok(plan[0].prompt.startsWith('52 year old Kashmiri man, light brown skin'),
    'identity leads, with whitespace normalised — it is frozen text and two spaces stay two spaces');
  // Wardrobe and location VARY here, which is the opposite of the identity
  // block's rule: a model trained on one outfit in one room learns the outfit
  // and the room are part of the person.
  assert.notStrictEqual(plan[0].prompt, plan[1].prompt);
});

test('a seed fits in what JSON can carry back exactly', () => {
  // fal echoes the seed, and a value past MAX_SAFE_INTEGER returns as a
  // different number — a stored seed that cannot reproduce its own image.
  const plan = Prompt.plan({ avatar: {}, look: {}, vocab: {}, count: 50, random: () => 0.999999 });
  for (const f of plan) assert.ok(Number.isSafeInteger(f.seed) && f.seed < 2 ** 31);
});

test('the batch floor is the gate, not one', () => {
  // Below 24 a batch cannot produce an exportable set however good the frames
  // are, so offering it would be selling a result that cannot be used.
  assert.strictEqual(Seed.MIN_BATCH, 24);
  assert.ok(Seed.MAX_BATCH <= 400);
});

// ── The stage ────────────────────────────────────────────────────────────────

test('seed generation is its own stage, so the LoRA guards stay intact', () => {
  // runStill, assemblePrompt and createShoot all refuse without an active LoRA,
  // and all three are right: for any other render a missing LoRA means the
  // wrong face. This is the one step that creates the LoRA, so it gets its own
  // name rather than a hole punched in three guards.
  const jobs = strip(read(path.join(ROOT, 'src', 'controllers', 'studioJobController.js')));
  assert.match(jobs, /'seed_still'/, 'the stage must be claimable');

  // METERED lives with settlement rather than with the HTTP route, because a
  // render that finishes in-process settles through the same service and the
  // meter must mean one thing on both paths.
  const settle = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));

  // Deliberately NOT in METERED any more. It was, drawing on
  // `still_megapixels` — the month's SHOOTING budget — so setting an avatar up
  // cost a month of posts, and no plan's still allowance covered even one pool.
  // Candidates now come out of a per-avatar allowance instead.
  assert.doesNotMatch(settle, /seed_still: \{ metric: 'still_megapixels'/,
    'candidate frames must not draw on the monthly still meter');
  // Read UNstripped for this one: the explanation is a comment, and `strip`
  // removes comments — asserting a comment against stripped source is a check
  // that can only ever fail.
  const settleRaw = read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js'));
  assert.match(settleRaw, /seed_still is deliberately ABSENT/,
    'the omission must be explained, or someone will helpfully add it back');

  const fal = strip(read(path.join(ROOT, 'worker', 'providers', 'fal.js')));
  assert.match(fal, /case 'seed_still': return this\.runSeedStill/);
  assert.match(fal, /seed_still: process\.env\.FAL_BASE_MODEL/,
    'it must point at base Flux, not the LoRA endpoint');

  // The original guard is untouched.
  const stillInput = fal.slice(fal.indexOf('_stillInput('));
  assert.match(stillInput.slice(0, 600), /NO_LORA/, 'runStill must still refuse without a LoRA');

  // And a seed job that somehow carries one is refused, because a trained face
  // in the set that defines that face is circular.
  assert.match(fal, /SEED_WITH_LORA/);

  const worker = strip(read(path.join(ROOT, 'worker', 'index.js')));
  assert.match(worker, /seed_still/, 'a worker asking only for `still` never picks these up');
});

// ── Paying for it ────────────────────────────────────────────────────────────

test('the whole batch is reserved once, not job by job', () => {
  // Forty jobs that each pass their own check and then run out of allowance at
  // frame thirty-one is a half-generated pool nobody asked for and everybody
  // paid for.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  const fn = svc.slice(svc.indexOf('async function queue('));

  const reserve = fn.indexOf('reserveFrames(');
  const enqueue = fn.indexOf('RenderJob.enqueueTx');
  assert.ok(reserve > -1 && enqueue > -1, 'both steps must be present');
  assert.ok(reserve < enqueue, 'the whole batch is taken before the first job is queued');

  // Against the avatar, not the month. And the row is locked before it is read,
  // or two tabs both see the same remaining allowance and both spend it.
  const take = svc.slice(svc.indexOf('async function reserveFrames'));
  assert.match(take, /FROM avatars WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/);
  assert.match(take, /'seed_frames', 'lifetime'/);
  assert.match(take, /seed_frames_used = seed_frames_used \+ \$2/);

  // The service takes a client rather than opening its own transaction, so
  // avatar creation can queue a batch in the SAME one that created the avatar.
  assert.match(svc, /async function queue\(client, \{/);
  assert.doesNotMatch(fn, /client\.query\('BEGIN'\)/, 'the caller owns the transaction');
});

test('a refusal says what to do instead of just refusing', () => {
  const src = read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')).replace(/\s+/g, ' ');
  assert.match(src, /status\(402\)/, 'over quota is a payment problem, not a bad request');
  assert.match(src, /You could generate \$\{priced\.affordable_count\} now/,
    'it must offer the batch they can actually afford');
  assert.match(src, /This avatar has \$\{priced\.allowance\.left\} of its \$\{priced\.allowance\.included\}/,
    'and say what this avatar had, not what the month had');

  // And that number has to be computed, not guessed.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  assert.match(svc, /affordable_count: affordableCount\(/);
});

test('credits are split across the batch without leaking a fraction', () => {
  // Settlement happens per job, so each job must carry its share. Splitting a
  // whole number of credits evenly with a float loses the remainder on every
  // batch, in our favour, which is the direction that never gets reported.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  assert.match(svc, /Math\.floor\(fromCredits \/ frames\)/);
  assert.match(svc, /remainder = fromCredits - perJob \* frames/);
  assert.match(svc, /i === 0 \? remainder : 0/, 'the remainder must land on exactly one job');
});

test('a double-clicked button cannot buy two pools', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  assert.match(svc, /idempotency_key: `seed:\$\{avatar\.id\}:\$\{batch\}:\$\{frame\.index\}`/);
});

test('a twin cannot generate its own training material without consent', () => {
  // Refusing only at training would mean the frames existed first — which is
  // the thing consent is about.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(src, /CONSENT_REQUIRED/);

  // Checked before the batch is queued, on BOTH paths — creating an avatar can
  // start a batch too, and a rule stated in one place and not the other is a
  // rule with a way around it.
  const gen = src.slice(src.indexOf('exports.generate'));
  const check = gen.indexOf('consentRefusal');
  const queue = gen.indexOf('SeedBatch.queue');
  assert.ok(check > -1 && queue > -1 && check < queue, 'generate checks consent before queueing');

  const avatarCtl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const create = avatarCtl.slice(avatarCtl.indexOf('exports.create'));
  const c2 = create.indexOf('consentRefusal');
  const q2 = create.indexOf('SeedBatch.queue');
  assert.ok(c2 > -1 && q2 > -1 && c2 < q2, 'creation checks it too, before queueing');
});

// ── Landing the frames ───────────────────────────────────────────────────────

test('a finished job becomes a candidate, or the money bought nothing', () => {
  // The job finishing is not the same as the frame being in the pool. Without
  // this the bytes sit in storage, the money is spent, and the screen says "no
  // photos yet" — the same class of bug as lora_train succeeding and writing no
  // avatar_loras row.
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));
  assert.match(src, /done\.stage === 'seed_still'/);
  assert.match(src, /SeedCandidates\.recordGenerated/);

  // Outside the completing transaction, and never able to undo it: the job IS
  // finished, and a failed insert must not hand it back to be paid for twice.
  assert.ok(src.indexOf('COMMIT') > -1 && src.indexOf('recordArtefacts') > -1,
    'both the commit and the recording must be present to be ordered');
  assert.ok(src.indexOf('await recordArtefacts') > src.indexOf('COMMIT'),
    'the frame is recorded after the money is settled, not inside it');

  // Axes off the job's own cell, not parsed back out of a filename the worker
  // composed.
  const fn = src.slice(src.indexOf("done.stage === 'seed_still'"));
  assert.match(fn.slice(0, 1400), /cell: p\.cell/);
  assert.doesNotMatch(fn.slice(0, 1400), /parseCandidate/);
});

test('recording a frame never overwrites a verdict', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  const fn = svc.slice(svc.indexOf('async function recordGenerated'));
  const cut = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(cut, /ON CONFLICT \(avatar_id, filename\) DO UPDATE/);
  const set = cut.slice(cut.indexOf('DO UPDATE'));
  assert.doesNotMatch(set, /verdict/);
});

test('a queued frame is served from storage, a local one from disk', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  const fn = src.slice(src.indexOf('exports.image'), src.indexOf('exports.exportSet'));

  assert.match(fn, /if \(avatar\.storage_key\)/, 'a row knows which it is');
  // readUrl presigns; publicUrl does not. A public URL here would undo the
  // signature this endpoint just checked.
  assert.match(fn, /readUrl\(/);
  assert.doesNotMatch(fn, /publicUrl\(/);
  // The local path survives — it costs nothing and is how R&D happens.
  assert.match(fn, /personaDir\(avatar\.slug\)/);
});

test('the unauthenticated image route cannot shadow an authenticated one', () => {
  // `/avatars/:id/candidates/:filename` is four segments and is registered
  // before `authenticate`, so it matched `/avatars/:id/candidates/quote` and
  // answered a signed-image 404 to a caller asking what a batch would cost.
  const routes = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  assert.match(routes, /'\/avatars\/:id\/candidates\/img\/:filename'/,
    'the unauthenticated route needs its own segment');
  assert.doesNotMatch(routes, /'\/avatars\/:id\/candidates\/:filename'/);

  // And the URLs the server mints must use it.
  const url = Seed.signedUrl(9, 2, 'frame.png');
  assert.match(url, /\/candidates\/img\/frame\.png\?/);
});

// ── The screen ───────────────────────────────────────────────────────────────

test('the customer-facing screen does not print shell commands', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const body = strip(page);
  assert.doesNotMatch(body, /npm run studio:/, 'a customer has no repository, no GPU and no terminal');
  assert.match(body, /function Generate/, 'there must be a button instead');
  assert.match(body, /candidates\/generate/);
});

test('the price is on the button, before it is pressed', () => {
  // Generation is billed by the megapixel, and a hundred frames is more than
  // Pro's entire monthly still allowance. A button that spends someone's month
  // without saying so is one they find out about on an invoice.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')).replace(/\s+/g, ' ');
  assert.match(page, /candidates\/quote\?count=/, 'the cost must be fetched as the number changes');
  assert.match(page, /Left in this avatar(&rsquo;|&#8217;|’|')s allowance/,
    'the allowance belongs to the avatar, not to the month');
  assert.match(page, /From bought credits/);
  assert.match(page, /Short by/, 'and say plainly when it cannot be afforded');
  // The button is disabled rather than allowed to fail.
  assert.match(page, /disabled=\{busy \|\| !quote \|\| short\}/);
});

// ── Generating as part of creating ───────────────────────────────────────────

test('creating an avatar can start its photos, and says the price on the form', () => {
  // "No photos to choose from yet" with a button on it is a dead end: the
  // moment somebody has finished describing a face is the moment they want to
  // see it. On by default — but with the cost on the form, because a form that
  // quietly spends a month's allowance is one people find out about on an
  // invoice.
  const form = read(path.join(FE, 'app', 'avatars', 'new', 'page.jsx')).replace(/\s+/g, ' ');
  assert.match(form, /useState\(true\)/, 'generation must default to on');
  assert.match(form, /candidates\/quote\?count=/, 'and the form must price it');
  assert.match(form, /generate: \{ count: genCount \}/, 'and send it with the avatar');
  assert.match(form, /Included with this avatar/,
    '"every avatar comes with N photos" is a sentence; a monthly megapixel budget is a calculation');
  assert.match(form, /Short by/, 'and say plainly when it cannot be afforded');

  // The quote the form uses is not scoped to an avatar, because the avatar does
  // not exist yet.
  const routes = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  assert.match(routes, /'\/candidates\/quote'/);
});

test('a refused batch does not take the avatar with it', () => {
  // The identity block is the expensive part: composed carefully, frozen, and
  // the avatar slot already spent. Throwing it away because this month's still
  // allowance is short would make somebody write it twice for a reason that has
  // nothing to do with it.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn = src.slice(src.indexOf('exports.create'));

  assert.match(fn, /SAVEPOINT before_generation/, 'the avatar needs a savepoint to survive behind');
  const save = fn.indexOf("client.query('SAVEPOINT before_generation')");
  const queue = fn.indexOf('SeedBatch.queue');
  const undo = fn.indexOf('ROLLBACK TO SAVEPOINT before_generation');
  const commit = fn.indexOf("client.query('COMMIT')");
  assert.ok(save > -1 && queue > -1 && undo > -1 && commit > -1, 'all four steps must exist');
  assert.ok(save < queue, 'the savepoint must be taken before anything it protects against');
  assert.ok(undo < commit, 'and the unwind must happen before the commit that keeps the avatar');

  // Only a quota refusal is caught. Anything else is a real failure and must
  // not leave a half-built avatar looking successful.
  assert.match(fn, /if \(err\.code !== StudioUsage\.QUOTA_EXCEEDED\) throw err/);
});

test('both ways of starting a batch use the same service', () => {
  // Two copies would be two copies that disagree about what a batch costs, and
  // the one that undercharges is the one nobody reports.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  assert.match(svc, /async function queue\(/);
  assert.match(svc, /reserveFrames\(client/, 'the service owns taking the allowance');
  assert.match(svc, /idempotency_key: `seed:/);

  for (const f of ['studioAvatarController.js', 'studioCandidateController.js']) {
    const src = strip(read(path.join(ROOT, 'src', 'controllers', f)));
    assert.match(src, /SeedBatch\.queue\(/, `${f} must go through the service`);
    assert.doesNotMatch(src, /RenderJob\.enqueueTx/, `${f} must not queue jobs itself`);
    assert.doesNotMatch(src, /seed_frames_used/, `${f} must not touch the counter itself`);
  }
});

test('a batch still arriving is not an empty pool', () => {
  // The seconds between queueing eighty frames and the first one landing would
  // otherwise look exactly like never having generated anything — to somebody
  // who has just been charged for eighty.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /generating/, 'the API must report a batch in flight');
  assert.match(ctl, /status IN \('queued','claimed','running'\)/);

  const page = strip(read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')));
  assert.match(page, /function Arriving/, 'and the screen needs a state for it');
  const branch = page.slice(page.indexOf('if (!candidates.length'));
  assert.ok(branch.indexOf('data.generating') < branch.indexOf('NoFrames'),
    'the arriving state must be checked before falling back to the empty one');

  // And the poll has to move faster while it is happening, or "arriving" is a
  // static picture.
  assert.match(page, /arriving \? 4000 : 15000/);
});

// ── The per-avatar allowance ─────────────────────────────────────────────────

test('candidate frames do not come out of the month\'s shooting budget', () => {
  // They did, and the arithmetic said no plan could set up a single avatar: a
  // usable pool is about eighty frames at a megapixel each, and the whole
  // monthly still allowance is 15 on Free, 40 on Pro, 160 on Max. Every
  // customer has to do this before they can make anything at all.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '049_seed_allowance.sql'));
  assert.match(sql, /^\s*ADD COLUMN IF NOT EXISTS seed_frames_used/m);
  assert.match(sql, /'seed_frames', 40, 'lifetime'/, 'free tier');
  assert.match(sql, /'pro', 'seed_frames', 120/);
  assert.match(sql, /'max', 'seed_frames', 200/);

  // An avatar whose pool predates this has already spent the frames; leaving it
  // at zero would hand it a second free allowance.
  assert.match(sql, /UPDATE avatars a\s*\n\s*SET seed_frames_used = c\.n/);
});

test('the cap is per avatar, and the counter is locked before it is read', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  const fn = svc.slice(svc.indexOf('async function reserveFrames'));
  const cut = fn.slice(0, fn.indexOf('\n}\n'));

  const lock = cut.indexOf('FOR UPDATE');
  const read_ = cut.indexOf('seed_frames_used || 0');
  assert.ok(lock > -1 && read_ > -1 && lock < read_,
    'two tabs must not both see the same remaining allowance and both spend it');

  // Only the plan portion increments the counter. Frames bought with credits
  // were paid for separately, and charging them to the allowance too would make
  // buying more raise the price of the next batch.
  assert.match(cut, /if \(fromPlan > 0\)/);
  assert.doesNotMatch(cut, /seed_frames_used \+ \$2.*overage/s);
});

test('a failed frame returns its allowance and its credits', () => {
  // A frame fal refused is a frame nobody got. Charging for it makes failures
  // profitable, and a bad run would quietly eat an avatar's whole included set.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  const fn = svc.slice(svc.indexOf('async function releaseFrame'));
  assert.match(fn, /GREATEST\(0, seed_frames_used - \$2\)/,
    'a double settle must not drive the counter negative and mint an allowance');
  assert.match(fn, /CreditLedger\.refund/);

  // And the failure path must actually call it — seed_still is not in METERED,
  // so the generic settle never sees these jobs.
  const jobs = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));
  const fail = jobs.slice(jobs.indexOf('async function failed'), jobs.indexOf('async function completed'));
  assert.ok(fail.length > 0, 'the failure path must be findable');

  const branch = fail.indexOf("stage === 'seed_still'");
  const release = fail.indexOf('SeedBatch.releaseFrame');
  assert.ok(branch > -1 && release > -1 && branch < release,
    'a failed seed frame must be released explicitly');
  // Only a PERMANENTLY failed one. A job going back on the queue keeps what it
  // reserved, because the retry will spend it.
  assert.match(fail, /status === 'failed' && [a-z]+\.stage === 'seed_still'/,
    'a requeued frame must not be refunded — it is going to run again');

  // What each job took is carried on the job, because by the time it finishes
  // the counters have moved on.
  assert.match(svc, /_seed_plan: i < planFrames \? 1 : 0/);
  assert.match(jobs, /_seed_plan/);
});
