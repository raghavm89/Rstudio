'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const I = require('../src/services/studio/identityBlock');

/**
 * Creating an avatar.
 *
 * The identity block is the most expensive field in the product to get wrong:
 * it is concatenated verbatim into every prompt this avatar ever generates, it
 * is frozen, and nothing about getting it wrong is visible at the time. You
 * find out three hundred images later that all of them are smiling in a red
 * saree, because those words went in on day one.
 */

const GOOD = {
  age: '26', origin: 'North Indian', presenting: 'woman', skin: 'warm medium-brown skin',
  build: 'lean athletic build', height: '5 foot 6',
  hair: 'dark brown hair to mid-back, loose natural wave',
  eyes: 'dark brown almond eyes', face: 'oval face, soft jaw',
  mark: 'a small mole below the left eye',
};

// ── The block itself ─────────────────────────────────────────────────────────

test('a well-formed block passes and lands in the documented word range', () => {
  const block = I.compose(GOOD);
  const v = I.validate(block, { name: 'Aanya Kapoor' });
  assert.ok(v.ok, `refused: ${v.errors.map((e) => e.code).join(', ')}`);
  assert.ok(v.words >= I.WORD_MIN && v.words <= I.WORD_MAX, `${v.words} words`);
  // Physical, comma-separated, no sentence. The shape matters — this string is
  // concatenated into a prompt, not read as prose.
  assert.ok(!/\.\s/.test(block), 'the block should not contain sentences');
});

test('a variable that changes shot to shot is refused', () => {
  // The whole reason the rule exists. Clothing, mood, place and light are what a
  // SHOOT decides; freezing one into identity puts it in every image forever.
  // Each case is chosen so that exactly ONE list entry can catch it. Writing
  // "wearing a red saree" tests only "wearing" — drop "saree" from the list and
  // the test still passes, which is a test that pins nothing.
  for (const [what, block] of [
    ['the verb',   I.compose({ ...GOOD, mark: 'wearing gold jhumkas' })],
    ['a garment',  I.compose({ ...GOOD, mark: 'a red saree' })],
    ['a second garment', I.compose({ ...GOOD, mark: 'a linen kurta' })],
    ['mood',       I.compose({ ...GOOD, face: 'a warm smile' })],
    ['place',      I.compose({ ...GOOD, mark: 'at the beach' })],
    ['light',      I.compose({ ...GOOD, skin: 'medium-brown skin, golden hour' })],
  ]) {
    const v = I.validate(block, { name: 'Aanya' });
    assert.ok(v.errors.some((e) => e.code === 'LEAKED_VARIABLE'), `${what} was allowed through`);
  }
});

test('the plastic-skin vocabulary is refused', () => {
  // "Flawless" and its relatives are instructions to erase pores, asymmetry and
  // stray hairs — the texture that makes a face read as a photograph.
  const v = I.validate(I.compose({ ...GOOD, skin: 'flawless porcelain skin' }), { name: 'A' });
  assert.ok(v.errors.some((e) => e.code === 'BANNED_LOOK'));
});

test('the name is refused, because the model has opinions about names', () => {
  const v = I.validate(`Aanya, ${I.compose(GOOD)}`, { name: 'Aanya Kapoor' });
  assert.ok(v.errors.some((e) => e.code === 'CONTAINS_NAME'));

  // But a short name that happens to be a substring of an ordinary word must
  // not fire — "Al" inside "almond" would refuse a perfectly good block.
  const clean = I.validate(I.compose(GOOD), { name: 'Al' });
  assert.ok(clean.ok, `a two-letter name matched inside a word: ${JSON.stringify(clean.errors)}`);
});

test('every problem is reported at once, not one per attempt', () => {
  // A form that reveals one rule per submit is a form abandoned on the third try.
  const v = I.validate(
    'Aanya, a smiling woman wearing a red saree, flawless porcelain skin, in golden hour sunlight',
    { name: 'Aanya Kapoor' }
  );
  const codes = v.errors.map((e) => e.code);
  for (const expected of ['TOO_SHORT', 'LEAKED_VARIABLE', 'BANNED_LOOK', 'CONTAINS_NAME']) {
    assert.ok(codes.includes(expected), `${expected} not reported; got ${codes.join(', ')}`);
  }
});

test('a LoRA trigger must not be a word the model already knows', () => {
  // A real word inherits everything the base model thinks that word looks like.
  for (const bad of ['sunflower', 'aanya', 'ab1', '', 'Aanya123', 'a4ny4-prsn']) {
    assert.ok(!I.validTrigger(bad), `"${bad}" should be refused`);
  }
  assert.ok(I.validTrigger('a4ny4prsn'));
  for (const name of ['Aanya Kapoor', 'Bo', '', 'Zeeshan', '李雷']) {
    assert.ok(I.validTrigger(I.suggestTrigger(name)), `suggested an invalid trigger for "${name}"`);
  }
});

// ── One definition of the rules ──────────────────────────────────────────────

test('the CLI and the API read the same rules', () => {
  // These lived as die() calls inside load-persona.js, where an HTTP request
  // could not reach them — so the form would have had to restate them, and two
  // statements of one rule is one statement that quietly stops being true.
  const cli = strip(read(path.join(ROOT, 'studio', 'load-persona.js')));
  assert.match(cli, /Identity\.validate\(/, 'load-persona must use the shared module');
  assert.match(cli, /Identity\.validTrigger\(/);
  // And must no longer carry its own copy.
  assert.doesNotMatch(cli, /the cap is 45/, 'the CLI still states the word cap itself');
  assert.doesNotMatch(cli, /'porcelain'/, 'the CLI still has its own banned-word list');
});

test('the browser is served the word lists rather than keeping a copy', () => {
  const rules = I.rules();
  assert.deepStrictEqual(rules.leaked, I.LEAKED);
  assert.deepStrictEqual(rules.banned, I.BANNED);
  assert.strictEqual(rules.word_max, I.WORD_MAX);

  const page = read(path.join(FE, 'app', 'avatars', 'new', 'page.jsx'));
  assert.match(page, /rules\.leaked/,  'the form must check against the served list');
  assert.match(page, /rules\.word_max/);
  // No second copy of the words themselves.
  assert.doesNotMatch(page, /'porcelain'|"porcelain"/, 'the form restates the banned list');
  assert.doesNotMatch(page, /'saree'|"saree"/,         'the form restates the leaked list');
});

// ── The endpoint ─────────────────────────────────────────────────────────────

test('creation validates server-side, whatever the form did', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.create'));

  assert.match(fn, /Identity\.validate\(/, 'the POST must re-check the block itself');
  // Before anything is written.
  const check = fn.indexOf('Identity.validate(');
  const insert = fn.indexOf('INSERT INTO avatars');
  assert.ok(check > -1 && check < insert, 'the block is validated before the row is written');
});

test('the lifetime cap is taken inside the transaction that creates the row', () => {
  // Two tabs submitting at once would otherwise both read "0 of 1 used" and both
  // create one. `reserve` is an atomic upsert, so the second sees the first.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.create'));
  const begin  = fn.indexOf("client.query('BEGIN')");
  const rsv    = fn.indexOf('StudioUsage.reserve');
  const insert = fn.indexOf('INSERT INTO avatars');
  assert.ok(begin > -1 && begin < rsv && rsv < insert,
    'reserve must happen inside the transaction and before the insert');
  assert.match(fn, /'avatars', 1, 'lifetime'/);
});

test('a lifetime cap follows the plan instead of freezing at signup', () => {
  // The bug this replaced: `limit_value` is snapshotted when a period opens so a
  // mid-month downgrade cannot shrink a month already paid for. A lifetime
  // metric has no new month — its row opens once at 1970-01-01 and never rolls
  // over — so the snapshot froze the cap at whatever plan the tenant was on when
  // they made their FIRST avatar. Someone on Free with one avatar who then paid
  // ₹2,000 for Pro and its three was still refused the second.
  const src = strip(read(path.join(ROOT, 'src', 'models', 'studioUsage.js')));
  const fn  = src.slice(src.indexOf('async reserve('));

  assert.match(fn, /const lifetime = period === 'lifetime'/,
    'reserve must distinguish a lifetime bucket from a monthly one');
  assert.match(fn, /CASE WHEN \$5 THEN \$4/,
    'a lifetime limit must be re-read, not coalesced from the frozen snapshot');
  // And the monthly snapshot must survive — it is protecting a month already
  // paid for.
  assert.match(fn, /ELSE COALESCE\(studio_usage_counters\.limit_value, \$4\)/,
    'monthly metrics must keep the snapshot');
});

test('the look profile is created with the avatar, not lazily', () => {
  // Every default in it is a decision — lens, grain, colour. A row that appears
  // later appears with whatever the defaults were then.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.create'));
  assert.match(fn, /INSERT INTO look_profiles/);
  const look = fn.indexOf('INSERT INTO look_profiles');
  const commit = fn.indexOf("client.query('COMMIT')");
  assert.ok(look > -1 && commit > -1, 'both statements must be present to be ordered');
  assert.ok(look < commit, 'the look profile must be part of the same transaction');
});

test('reference mode is refused with a sentence before the constraint refuses it with an error', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.create'));
  assert.match(fn, /\['synthetic', 'twin'\]\.includes\(mode\)/);
  // The database says the same thing, and that is the layer that counts.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '033_drop_reference_mode.sql'));
  assert.match(sql, /mode IN \('synthetic', ?'twin'\)/);
});

// ── The list ─────────────────────────────────────────────────────────────────

test('the avatar list is tenant-scoped and authenticated', () => {
  // It used to `fetch('/cull/api/avatars')` — port 5055, no auth, no tenant
  // scoping, answering with every avatar in the database.
  // Stripped, because the page's own comment explains what it used to do and
  // names the old endpoint — a check against the raw text would fail on the
  // explanation of the fix.
  const page = strip(read(path.join(FE, 'app', 'avatars', 'page.jsx')));
  assert.doesNotMatch(page, /\/cull\/api\/avatars/, 'the page still reads the culling service');
  assert.match(page, /useResource\('\/avatars'\)/, 'it must read the authenticated Studio API');

  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.list'), src.indexOf('exports.identityRules'));
  assert.match(fn, /WHERE a\.tenant_id = \$1/, 'the list must be scoped to the caller\'s tenant');

  const routes = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  assert.match(routes, /router\.get\s*\('\/avatars',\s*authorize\(\.\.\.TENANT_ROLES\)/);
});

test('a twin says it cannot train before the seed set is paid for, not after', () => {
  // Otherwise it is discovered at the train button, by which point hundreds of
  // candidate frames have been generated and billed.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  assert.match(src, /consent_pending/, 'the list must report whether consent is outstanding');
  assert.match(src, /consent_required: mode !== 'synthetic'/, 'and creation must say so on the way out');

  // Collapsed first: JSX wraps prose, so a copy check against the raw file
  // asserts where the editor broke the line rather than what the line says.
  const form = read(path.join(FE, 'app', 'avatars', 'new', 'page.jsx')).replace(/\s+/g, ' ');
  assert.match(form, /cannot be trained yet/i, 'the form must warn before the mode is chosen');
  assert.match(form, /counts against your avatar allowance/i,
    'and say that it still consumes the allowance');
});

// ── Dev credits ──────────────────────────────────────────────────────────────

test('the dev top-up tops up rather than adding, and stays out of production', () => {
  // Granting a flat 1000 each run leaves 4000 after four runs and the balance
  // stops meaning anything. This grants the difference.
  const src = strip(read(path.join(ROOT, 'scripts', 'dev-credits.js')));
  assert.match(src, /const gap = TARGET - before/, 'it must grant the difference, not the target');
  assert.match(src, /if \(gap <= 0\)/, 'and do nothing when already at target');
  assert.match(src, /NODE_ENV === 'production'/, 'and refuse to run in production');
  assert.match(src, /FOR UPDATE/, 'and lock before reading, like every other ledger writer');
  assert.match(src, /CreditLedger\.purchase/, 'through the ledger, not its own INSERT');
  assert.match(src, /admin\.credits\.grant/, 'and leave the same audit trail as a hand grant');
});

// ── Where "New avatar" lands you ─────────────────────────────────────────────

// The face screen's own behaviour moved to tests/culling.test.js when the
// culling service stopped being a web server. Two tests lived here that
// asserted the shape of the interim fix — a `fetchFrames` helper wrapping
// :5055 — and that shape is gone. Deleting them rather than loosening them:
// a test kept alive by weakening its assertion is worse than no test.

test('one avatar is fetched tenant-scoped, and a stranger\'s looks missing', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const fn  = src.slice(src.indexOf('exports.get'), src.indexOf('exports.identityRules'));
  assert.match(fn, /WHERE a\.id = \$1 AND a\.tenant_id = \$2/,
    'the lookup must be scoped to the caller\'s tenant');
  // 404, not 403: confirming an id exists but is not yours still confirms it exists.
  assert.match(fn, /status\(404\)/);
  assert.doesNotMatch(fn, /status\(403\)/);

  const routes = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  // The literal segment must be registered before the parameter, or /avatars/rules
  // is swallowed by /avatars/:id and parseId rejects "rules".
  const rulesAt = routes.indexOf("'/avatars/rules'");
  const idAt    = routes.indexOf("'/avatars/:id'");
  assert.ok(rulesAt > -1 && idAt > -1, 'both routes must exist to be ordered');
  assert.ok(rulesAt < idAt, '/avatars/rules must be registered before /avatars/:id');
});


test('custom avatars — person or character — are gated to Pro+ (offering §1)', () => {
  // Free and Catalogue use the shared catalogue only; building your own avatar
  // or character starts at Pro. Enforced in the API, not just the UI.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  assert.match(src, /currentPlanFor/, 'creation must resolve the tenant plan');
  assert.match(src, /CUSTOM_REQUIRES_PRO/, 'a non-Pro tenant is refused a custom build');
  assert.match(src, /'pro', 'max', 'ultra'/, 'only Pro and up may build custom');
  assert.match(src, /req\.user\.role !== 'admin'/, 'admins (catalogue builders) are exempt');
});
