'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

process.env.STUDIO_STORAGE_SECRET = process.env.STUDIO_STORAGE_SECRET || 'test-secret-for-culling';
const Seed = require('../src/services/studio/seedCandidates');

/**
 * Culling, after it stopped being a web server.
 *
 * `studio/cull.js` listened on :5055 with no authentication and no tenant
 * scoping: `/api/candidates?avatar=N` answered for any N to anyone who could
 * reach the port, `/img/<id>/<file>` served the pictures the same way, and the
 * verdicts lived in a JSON file next to them — belonging to a directory rather
 * than to a workspace.
 */

// ── The filename is the metadata ─────────────────────────────────────────────

test('the coverage cell is parsed from the right, because an angle contains the separator', () => {
  // `three-quarter` has a hyphen in it, so parsing from the left mis-splits it
  // and every three-quarter frame silently vanishes from the coverage strip.
  const c = Seed.parseCandidate('0001-medium-three-quarter-soft-1234567890123456789.png');
  assert.deepStrictEqual(
    { idx: c.idx, framing: c.framing, angle: c.angle, quality: c.quality },
    { idx: 1, framing: 'medium', angle: 'three-quarter', quality: 'soft' });

  // The seed stays a string. fal returns values past MAX_SAFE_INTEGER, and a
  // rounded float cannot reproduce its own image.
  assert.strictEqual(c.seed, '1234567890123456789');
  assert.strictEqual(typeof c.seed, 'string');

  for (const junk of ['notes.txt', '0001-wide-front-soft-1.png', '0001-close-sideways-soft-1.png', 'x.png', '']) {
    assert.strictEqual(Seed.parseCandidate(junk), null, `"${junk}" should not parse`);
  }
});

test('coverage names what is missing and why it matters', () => {
  const kept = [
    { angle: 'front', framing: 'close', quality: 'soft' },
    { angle: 'front', framing: 'medium', quality: 'soft' },
  ];
  const gaps = Seed.coverageGaps(kept);
  const byKey = Object.fromEntries(gaps.map((g) => [g.key, g]));

  assert.ok(byKey.angle,   'two front-on frames cannot cover three angles');
  assert.ok(byKey.framing, 'nor close and medium cover full');
  assert.ok(byKey.quality, 'nor soft light cover hard');
  assert.deepStrictEqual(byKey.angle.missing, ['three-quarter', 'profile']);
  // Each rule carries the failure it prevents. A gate that only says "missing"
  // gets argued with; one that says what the model does without it does not.
  for (const g of gaps) assert.ok(g.why && g.why.length > 20, `${g.key} has no reason attached`);

  // A complete set has no gaps.
  const full = [];
  for (const angle of Seed.ANGLES) for (const framing of Seed.FRAMINGS) for (const quality of Seed.QUALITIES) {
    full.push({ angle, framing, quality });
  }
  assert.deepStrictEqual(Seed.coverageGaps(full), []);
});

test('one definition of the gate, read by everything', () => {
  // The axes and the required counts were stated in cull.js AND again in the
  // face page, with nothing making them agree. The failure mode is a screen
  // saying a set is complete and the export refusing it.
  const face = strip(read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')));
  assert.doesNotMatch(face, /const REQUIRED = \{/, 'the page restates the required counts');
  assert.doesNotMatch(face, /'three-quarter', 'profile'/, 'the page restates the axis values');

  const cull = strip(read(path.join(ROOT, 'studio', 'cull.js')));
  assert.match(cull, /require\(.*seedCandidates.*\)/, 'the registrar must use the shared module');
  assert.doesNotMatch(cull, /const COVERAGE = \[/, 'the registrar still has its own coverage rules');
  assert.doesNotMatch(cull, /function parseCandidate/, 'and its own parser');
});

// ── Signed image URLs ────────────────────────────────────────────────────────

test('a grant is for one image, in one workspace, for ten minutes', () => {
  // An `<img>` sends no Authorization header, so the read is authorised the way
  // the upload plane authorises writes. The signature covers tenant AND avatar
  // AND filename together — sign fewer of them and a grant for one picture is a
  // grant for the next.
  const url = Seed.signedUrl(9, 2, 'frame.png');
  const q = Object.fromEntries(new URLSearchParams(url.split('?')[1]));

  assert.ok(Seed.verify(9, 2, 'frame.png', q.exp, q.sig), 'its own grant must work');

  assert.ok(!Seed.verify(10, 2, 'frame.png', q.exp, q.sig), 'another tenant must not');
  assert.ok(!Seed.verify(9, 3, 'frame.png', q.exp, q.sig),  'another avatar must not');
  assert.ok(!Seed.verify(9, 2, 'other.png', q.exp, q.sig),  'another file must not');
  assert.ok(!Seed.verify(9, 2, 'frame.png', q.exp, 'f'.repeat(64)), 'a forgery must not');
  assert.ok(!Seed.verify(9, 2, 'frame.png', Number(q.exp) + 1, q.sig), 'nor an extended expiry');

  // Expiry is checked before the comparison, and a short signature must not
  // reach timingSafeEqual — which throws on a length mismatch, and the throw
  // would itself be a length oracle.
  assert.ok(!Seed.verify(9, 2, 'frame.png', q.exp, q.sig, Date.now() + Seed.TTL_MS + 1000), 'expired');
  assert.doesNotThrow(() => Seed.verify(9, 2, 'frame.png', q.exp, 'ab'));
  assert.ok(!Seed.verify(9, 2, 'frame.png', q.exp, 'ab'));
  assert.ok(!Seed.verify(9, 2, 'frame.png', 'not-a-number', q.sig));
});

test('no secret means no URLs, not open ones', () => {
  const saved = { a: process.env.STUDIO_STORAGE_SECRET, b: process.env.STUDIO_WORKER_TOKEN, c: process.env.JWT_ACCESS_SECRET };
  delete process.env.STUDIO_STORAGE_SECRET;
  delete process.env.STUDIO_WORKER_TOKEN;
  delete process.env.JWT_ACCESS_SECRET;
  try {
    assert.throws(() => Seed.signedUrl(9, 2, 'x.png'), /NO_SIGNING_SECRET|secret/i,
      'an unsigned URL is a forgeable one — this must fail closed');
  } finally {
    Object.assign(process.env, { STUDIO_STORAGE_SECRET: saved.a, STUDIO_WORKER_TOKEN: saved.b, JWT_ACCESS_SECRET: saved.c });
  }
});

test('the image route answers one status for every refusal', () => {
  // A different status for "no such avatar" than for "bad signature" tells an
  // unauthenticated caller which ids exist.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  const fn = src.slice(src.indexOf('exports.image'), src.indexOf('exports.exportSet'));

  assert.match(fn, /const deny = \(\) => res\.status\(404\)/);
  assert.doesNotMatch(fn, /status\(40[13]\)/, 'a 401 or 403 here distinguishes the failures');
  // A 302 to presigned storage is not a leak: it is only reached after the
  // signature has been checked, and the URL it hands out is itself short-lived.
  // Every REFUSAL is still the same 404.
  const refusals = [...fn.matchAll(/return (?:res\.status\((\d+)\)|deny\(\))/g)]
    .map((m) => m[1] || '404');
  for (const code of refusals) {
    assert.ok(['404', '503'].includes(code),
      `the image route refuses with ${code} somewhere — every refusal must look identical`);
  }

  // The tenant comes from the avatar row, never from the request. A tenant id in
  // the query string would be a value the caller picks, and the signature would
  // be proving their own claim back to them. (The lookup gained a join to
  // seed_candidates when queue-generated frames arrived; what matters is where
  // the tenant comes from, not the shape of the query.)
  assert.match(fn, /a\.tenant_id[\s\S]{0,120}FROM avatars a/);
  assert.doesNotMatch(fn, /req\.query\.tenant/);
  assert.doesNotMatch(fn, /req\.body\?\.tenant/);

  // basename, then a prefix check: the first stops traversal, the second stops
  // a symlinked persona directory from slipping past it.
  assert.match(fn, /path\.basename\(/);
  assert.match(fn, /startsWith\(dir \+ path\.sep\)/);
});

// ── Scoping ──────────────────────────────────────────────────────────────────

test('every read and write is scoped to the caller\'s tenant', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  for (const fn of ['async function list', 'async function mark', 'async function keptForExport']) {
    const body = svc.slice(svc.indexOf(fn));
    const cut = body.slice(0, body.indexOf('\n}\n'));
    assert.match(cut, /tenant_id = \$2/, `${fn} does not filter by tenant`);
  }

  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /WHERE id = \$1 AND tenant_id = \$2/, 'the avatar lookup must be scoped');
  assert.match(ctl, /status\(404\)\.json\(\{ error: 'No such avatar' \}\)/,
    'someone else\'s avatar must be indistinguishable from a missing one');
});

test('the denormalised tenant cannot disagree with the avatar', () => {
  // tenant_id is copied onto the candidate so reads need no join. That is only
  // safe if the two cannot drift, and "the application always sets it right" is
  // not a guarantee — fixtures, imports and support scripts write rows too.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '047_seed_candidates.sql'));
  // Anchored to the start of a line: an unanchored match is satisfied by the
  // statement sitting inside a `-- comment`, which is exactly how a mutation
  // run got past the previous version of this check.
  assert.match(sql, /^CREATE TRIGGER trg_seed_candidate_tenant/m);
  assert.match(sql, /^\s*BEFORE INSERT OR UPDATE OF avatar_id/m);
  assert.match(sql, /^\s*SELECT a\.tenant_id INTO NEW\.tenant_id/m);
});

test('an undecided candidate is not a rejected one', () => {
  // A boolean would have made "not looked at yet" and "looked at and rejected"
  // the same value, and the difference is the whole progress count.
  const sql = read(path.join(ROOT, 'src', 'db', 'migrations', '047_seed_candidates.sql'));
  assert.match(sql, /verdict\s+TEXT\s+CHECK \(verdict IN \('keep', 'reject'\)\)/);
  assert.doesNotMatch(sql, /verdict\s+BOOLEAN/);
});

// ── The registrar ────────────────────────────────────────────────────────────

test('re-registering adds frames without touching decisions', () => {
  // The generator may still be running while someone culls. An upsert that
  // included `verdict` in its SET list would wipe every judgement each time.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  const fn = svc.slice(svc.indexOf('async function register'));
  const cut = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(cut, /ON CONFLICT \(avatar_id, filename\) DO UPDATE/);
  const set = cut.slice(cut.indexOf('DO UPDATE'));
  assert.doesNotMatch(set, /verdict/, 'the upsert must not overwrite a verdict');
});

test('the fifteen decisions already on disk are imported, once', () => {
  // Without this step the frames already kept for Aanya would have been silently
  // un-decided, and nothing on screen would have said so.
  const src = strip(read(path.join(ROOT, 'studio', 'cull.js')));
  assert.match(src, /cull-state\.json/, 'the registrar must read the old state file');
  assert.match(src, /WHERE avatar_id = \$1 AND filename = \$2 AND verdict IS NULL/,
    'it must only fill in undecided rows, so a later decision in the app wins');
});

test('the registrar is not a server any more', () => {
  const src = strip(read(path.join(ROOT, 'studio', 'cull.js')));
  assert.doesNotMatch(src, /createServer|listen\(/, 'cull.js must not serve HTTP');
  assert.doesNotMatch(src, /5055/, 'nor mention the port it used to hold');
  assert.doesNotMatch(src, /writeFileSync/, 'nor write the state file it replaced');

  // And it must re-read avatars rather than caching them, which is the bug that
  // made a new avatar invisible to it. Asserted structurally: the previous
  // version of this looked for an explanatory COMMENT, which `strip` removes —
  // a check that could only ever fail.
  const queries = (src.match(/FROM avatars/g) || []).length;
  assert.ok(queries >= 2, 'the avatar list must be re-read on each pass, not cached at startup');
  const firstQuery = src.indexOf('FROM avatars');
  const closesPool = src.indexOf('pool.end()');
  assert.ok(closesPool === -1 || closesPool > firstQuery,
    'the pool must not be closed before the avatars are read — that is the bug this replaced');
});

// ── The screen ───────────────────────────────────────────────────────────────

test('the face screen no longer talks to :5055', () => {
  const page = strip(read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')));
  assert.doesNotMatch(page, /\/cull\//, 'the page still calls the culling service');
  assert.match(page, /useResource\(`\/avatars\/\$\{avatarId\}\/candidates`\)/);
  assert.match(page, /post\(`\/avatars\/\$\{avatarId\}\/candidates`/, 'decisions go to the API');
  // The button used to POST /seed-set/export and stop there. Training now
  // publishes the archive itself as part of submitting, so what the screen
  // asks for is the check and then the run — both on the API, which is what
  // this test is actually about.
  assert.match(page, /post\(`\/avatars\/\$\{avatarId\}\/train\/check`/);
  assert.match(page, /post\(`\/avatars\/\$\{avatarId\}\/train`/);
  assert.match(page, /get\(`\/avatars\/\$\{avatarId\}\/train`\)/, 'and polls it while a check runs');

  // The endpoint still exists and is still tested; nothing on this screen
  // needs it any more.
  const routes = read(path.join(ROOT, 'src', 'routes', 'studio.js'));
  assert.match(routes, /seed-set\/export/);

  // Images come from the URL the server signed, not from a path the page builds.
  assert.match(page, /src=\{c\.url\}/);
  assert.doesNotMatch(page, /src=\{`\/cull/);
});

test('the strip shows what the database says, not what the browser clicked', () => {
  // The optimistic update is a guess; the response is the answer. Without the
  // second half a dropped request leaves the coverage strip claiming a set is
  // complete when the export will refuse it.
  const page = strip(read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')));
  const mark = page.slice(page.indexOf('const mark = useCallback'));
  const cut = mark.slice(0, mark.indexOf('}, [candidates, cursor'));
  assert.match(cut, /const fresh = await post\(/);
  assert.match(cut, /keep: fresh\.keep, reject: fresh\.reject, gaps: fresh\.gaps/,
    'the server\'s recomputed state must replace the optimistic one');
  // And a decision that failed to save must say so.
  assert.match(cut, /not saved/i);
});

test('the poll does not re-mint every URL every fifteen seconds', () => {
  // Replacing the payload unconditionally would change every `img src` on each
  // poll, and every thumbnail in the grid would reload.
  const page = strip(read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')));
  const poll = page.slice(page.indexOf('setInterval'), page.indexOf('}, arriving ?'));

  // Replaced only when something actually moved. The condition grew a second
  // clause when batches arrived — a pool whose first frames have not landed
  // must still refresh, or the progress bar sits frozen at zero while jobs are
  // plainly finishing — but the rule is unchanged: never replace for nothing.
  assert.match(poll, /moved \? fresh : prev/, 'the payload must not be replaced unconditionally');
  assert.match(poll, /fresh\.candidates\.length !== prev\.candidates\.length/);
  assert.match(poll, /fresh\.generating\?\.pending !== prev\.generating\?\.pending/);

  const guard = poll.indexOf('Array.isArray(fresh?.candidates)');
  const deref = poll.indexOf('fresh.candidates.length');
  assert.ok(guard > -1 && deref > -1, 'both the guard and the read must be present');
  assert.ok(guard < deref, 'the shape must be checked before it is read');
});

test('having no frames offers a button, not a shell command', () => {
  // This used to assert the two npm commands were printed. They were, and that
  // was the bug: a developer instruction on a customer-facing screen, present
  // because the button was not. Generation is now a product action, so what is
  // worth asserting is that the action exists and states its price.
  //
  // The commands themselves are covered by tests/seedGeneration.test.js, which
  // asserts they are GONE.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx')).replace(/\s+/g, ' ');

  assert.match(page, /function NoFrames/);
  assert.match(page, /<Generate avatarId=/, 'the empty state must offer generation');
  assert.match(page, /frames on disk for this avatar that have not been registered/i,
    'a directory the database has not been told about is still a different problem');

  // The flag it branches on has to actually be sent, and must now account for
  // queue-generated frames as well as local ones.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /frames_present/, 'the API must report whether the pixels are reachable');
  assert.match(ctl, /some\(\(c\) => c\.storage_key\)/,
    'a storage-backed pool is reachable even with no persona directory on this machine');
});

// ── The screen that says it is working ───────────────────────────────────────

/**
 * Three separate reasons a user watching a batch land saw a frozen screen: the
 * bar had no pixels, the poll was answered from cache, and nothing was picking
 * the jobs up. Each is asserted here because each was invisible in isolation.
 */

test('a progress bar has geometry wherever it appears, not only in the sidebar', () => {
  // `.meter .track` styles the bar ONLY inside the sidebar's usage meter. Every
  // other bar in the app uses the same two class names and got no height and no
  // background — it rendered as literally nothing. The two on the Usage page
  // had never been visible.
  const css = read(path.join(FE, 'app', 'globals.css'));

  const track = css.match(/^\.track\s*\{([^}]*)\}/m);
  assert.ok(track, '.track must be a component rule, not scoped to `.meter .track`');
  assert.match(track[1], /height:\s*[1-9]/, 'a bar with no height is not on the screen');
  assert.match(track[1], /background:/, 'the empty part of the bar has to be visible');

  const fill = css.match(/^\.fill\s*\{([^}]*)\}/m);
  assert.ok(fill, '.fill must be a component rule too, or the bar has no filled part');
  assert.match(fill[1], /height:\s*100%/);
  assert.match(fill[1], /background:/);
  assert.match(fill[1], /transition:\s*width/,
    'frames land one at a time; a bar that jumps reads as a redraw, not as progress');

  // ...and the app really does draw bars outside the sidebar, which is what
  // made the scoped rule a bug rather than a deliberately narrow style.
  for (const rel of [['app', 'usage', 'page.jsx'],
                     ['app', 'avatars', '[id]', 'face', 'page.jsx']]) {
    assert.match(read(path.join(FE, ...rel)), /className="track/,
      `${rel.join('/')} draws a bar with these class names`);
  }
});

test('the poll that reports a changing number is never answered from cache', () => {
  // Express ETags every JSON response, so a poll whose body has not changed
  // comes back 304 and the browser replays the previous body. Harmless for a
  // static resource; here it froze "0 of 24" on screen while the server log
  // filled with `GET /candidates 304`.
  const ctl  = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  const list = ctl.slice(ctl.indexOf('exports.list'), ctl.indexOf('exports.mark'));
  assert.ok(list.length > 0, 'the list handler must be findable');

  const set  = list.search(/res\.set\(\s*['"]Cache-Control['"]\s*,\s*['"]no-store['"]/);
  const send = list.indexOf('res.json(');
  assert.ok(set > -1, 'the candidates poll must forbid caching');
  assert.ok(send > -1, 'the handler must send a body');
  assert.ok(set < send, 'headers have to be set before the body goes out');
});

test('"nothing has started these" needs both no claims and some age', () => {
  // A worker that is merely busy will still have claimed ONE job within two
  // minutes, so age alone would accuse a working system, and zero-claims alone
  // would accuse a batch queued four seconds ago.
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /claimed_at IS NOT NULL/,
    'the question can only be answered if the query asks it');

  const m = ctl.match(/stalled:\s*([\s\S]*?),\n/);
  assert.ok(m, 'the list response must carry a stalled flag');

  // Run the real expression rather than matching its text: the truth table is
  // the thing that matters, and it survives the expression being rewritten.
  const decide = new Function('batchRow', `return (${m[1]});`);
  assert.strictEqual(decide({ ever_claimed: 0, age_seconds: 4   }), false, 'just queued');
  assert.strictEqual(decide({ ever_claimed: 0, age_seconds: 120 }), false, 'exactly at the line');
  assert.strictEqual(decide({ ever_claimed: 0, age_seconds: 180 }), true,  'old and untouched');
  assert.strictEqual(decide({ ever_claimed: 1, age_seconds: 180 }), false, 'old but something took one');
  assert.strictEqual(decide({ ever_claimed: 8, age_seconds: 4   }), false, 'busy and new');
});

test('the elapsed counter reads as a clock', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));

  // It has to actually tick. `age_seconds` alone paints one number and stops,
  // which is what "there is no timer" meant.
  assert.match(page, /setInterval\(\s*\(\)\s*=>\s*setElapsed/,
    'the elapsed time must advance on its own');
  assert.match(page, /clearInterval/, 'and stop when the screen goes away');
  assert.match(page, /useState\(generating\.age_seconds/,
    'a tab opened five minutes in must not start counting from zero');

  const src = page.match(/function clock\(seconds\)\s*\{[\s\S]*?\n\}/);
  assert.ok(src, 'the m:ss helper must exist');
  const clock = new Function(`${src[0]}; return clock;`)();
  assert.strictEqual(clock(0),   '0:00');
  assert.strictEqual(clock(9),   '0:09');
  assert.strictEqual(clock(65),  '1:05');
  assert.strictEqual(clock(600), '10:00');
  assert.strictEqual(clock(-3),  '0:00', 'a clock never runs backwards');
});

test('the keep count states the floor, and names the cap only to someone who has hit it', () => {
  // "needs 12–40" reads as a window you have to land inside: at four kept it
  // looks like a target you are aiming at rather than a number you are short
  // of. Twelve is a requirement — below it the model learns the background
  // instead of the face. Forty is a cap, and a cap means nothing until you
  // reach it.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.doesNotMatch(page, /needs \{min\}[–-]\{max\}/, 'the range must not be presented as the requirement');

  // Run the two conditions rather than matching their text, so the truth table
  // is what is asserted and a rewrite of the expression does not slip past.
  const grab = (label, re) => {
    const m = page.match(re);
    assert.ok(m, `${label} must be rendered conditionally`);
    return new Function('kept', 'min', 'max', `return (${m[1]}) || '';`);
  };
  const floor = grab('the floor', /\{(kept\.length < min &&[^\n]*?)\}\n/);
  const cap   = grab('the cap',   /\{(kept\.length > max &&[^\n]*?)\}\n/);

  const shown = (n) => `${n} kept` + floor({ length: n }, 12, 40) + cap({ length: n }, 12, 40);

  assert.strictEqual(shown(4),  '4 kept · needs at least 12', 'short of the floor, say the floor');
  assert.strictEqual(shown(11), '11 kept · needs at least 12');
  assert.strictEqual(shown(12), '12 kept', 'at the floor there is nothing left to ask for');
  assert.strictEqual(shown(30), '30 kept', 'and a cap you are nowhere near is noise');
  assert.strictEqual(shown(40), '40 kept', 'the cap is inclusive — forty is allowed');
  assert.strictEqual(shown(41), '41 kept · at most 40', 'past it, and only then, say so');
});

test('the cap is still real, whatever the label says', () => {
  // Leading with the minimum must not turn the maximum into a suggestion: the
  // button stays shut past it, and the server refuses regardless of the button.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /kept\.length >= min && kept\.length <= max/,
    'the ready state must still bound both ends');

  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  assert.match(svc, /rows\.length < MIN_KEEP/, 'the floor is enforced where it matters');
  assert.match(svc, /rows\.length > MAX_KEEP/, 'and so is the cap');
  assert.strictEqual(Seed.MIN_KEEP, 12);
  assert.strictEqual(Seed.MAX_KEEP, 40);
});

// ── Saying what was chosen, and only what was actually chosen ────────────────

test('a kept photo is ticked, so a decision is a shape and not a border colour', () => {
  // Keeping and being under the cursor were both drawn as an outline, in two
  // colours, over photographs of every colour. "Which of these did I choose"
  // should not be a question you answer by squinting at edges.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  const tile = page.slice(page.indexOf('{candidates.map('), page.indexOf('{!candidates.length &&'));
  assert.ok(tile.length > 0, 'the grid tile must be findable');

  assert.match(tile, /keep\.has\(c\.filename\) && \(\s*<span className="cand-mark keep"/,
    'a kept tile must carry a mark of its own, not only an outline');
  assert.match(tile, /<svg/, 'drawn, so it stays crisp at any tile size');
  assert.match(tile, /reject\.has\(c\.filename\) && \(\s*<span className="cand-mark rej"/,
    'and a rejected one too — otherwise a dimmed tile is ambiguous with an undecided one');
  assert.match(tile, /aria-pressed=\{keep\.has\(c\.filename\)\}/,
    'the state has to reach anyone not looking at the colours');

  // A mark with no size or no ground is not on the screen — the same way
  // `.meter .track` made every progress bar in the app invisible.
  const css = read(path.join(FE, 'app', 'globals.css'));
  const mark = css.match(/^\.cand-mark\s*\{([^}]*)\}/m);
  assert.ok(mark, '.cand-mark must be styled');
  assert.match(mark[1], /position: absolute/);
  assert.match(mark[1], /width:\s*[1-9]/);
  assert.match(mark[1], /height:\s*[1-9]/);
  assert.match(css, /^\.cand-mark\.keep\s*\{[^}]*background:/m, 'the tick needs a ground to sit on');
  assert.match(css, /^\.cand-mark\.rej\s*\{[^}]*background:/m);
});

test('a decision that did not reach the server is taken back off the screen', () => {
  // This is the bug the comment already claimed to have fixed: the message said
  // "That decision was not saved" while the tile kept its edge, so the screen
  // showed four kept against a server holding none — and the count in the
  // corner was counting photos that do not exist.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));

  const markFn = page.slice(page.indexOf('const mark = useCallback'), page.indexOf('const undo = useCallback'));
  const failed = markFn.slice(markFn.indexOf('} catch (err) {'));
  assert.ok(failed.length > 0, 'mark must handle a failed write');
  assert.match(failed, /setData\(/, 'the optimistic edit has to be undone, not just announced');
  assert.match(failed, /previous === 'keep'/, 'and undone back to what the server still holds');
  assert.match(failed, /previous === 'reject'/);
  assert.match(failed, /history\.current\.splice/,
    'and dropped from the undo stack — undoing something that never happened is a second wrong write');

  // Removed by identity, not popped: another keystroke may have landed behind it.
  assert.match(failed, /indexOf\(entry\)/);

  const undoFn = page.slice(page.indexOf('const undo = useCallback'), page.indexOf('useEffect(() => {\n    const onKey'));
  const undoFailed = undoFn.slice(undoFn.indexOf('} catch (err) {'));
  assert.ok(undoFailed.length > 0, 'undo must handle a failed write too');
  assert.match(undoFailed, /setData\(/);
  assert.match(undoFailed, /last\.applied === 'keep'/, 'restored to what the frame was before the undo');
  assert.match(undoFailed, /last\.applied === 'reject'/, 'both verdicts, or half of them silently vanish');
  assert.match(undoFailed, /history\.current\.push\(last\)/, 'and the entry goes back on the stack');

  // Which is only possible because a mark records what it applied, not only
  // what was there before.
  assert.match(page, /const entry = \{ filename: c\.filename, previous, applied: verdict \}/);
});

test('the customer-facing failure names no terminal', () => {
  // Same rule as the face screen: a customer has no repository and no terminal,
  // and `npm run dev` on a screen they are looking at is a developer's note
  // left in the product.
  for (const rel of [['lib', 'api.js'], ['lib', 'auth.js']]) {
    const src = read(path.join(FE, ...rel));
    assert.doesNotMatch(src, /npm run/, `${rel.join('/')} tells a customer to run a command`);
    assert.doesNotMatch(src, /listening on :\d+/, `${rel.join('/')} names a port at a customer`);
    assert.match(src, /not responding/, 'it still has to say plainly that the request did not land');
  }
  // The machine-readable half is what code should branch on, and it stays.
  assert.match(read(path.join(FE, 'lib', 'api.js')), /code: 'API_UNREACHABLE'/);
});

// ── Exporting the set ────────────────────────────────────────────────────────

test('the export reads frames from wherever they actually live', () => {
  // Export used to check `fs.existsSync` in a persona directory and nothing
  // else. Queue-generated frames are objects in storage — which is every frame
  // the product itself makes — so all of them failed, and the screen said
  // "12 kept frames are not on this machine" about frames it had just made.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedExport.js')));
  const fn = svc.slice(svc.indexOf('async function frameBytes'), svc.indexOf('async function publish'));

  assert.match(fn, /if \(candidate\.storage_key\)/, 'a row knows which it is');
  assert.match(fn, /storage\.readUrl/, 'presigned — these are the training images of a face');
  assert.ok(!/publicUrl/.test(fn), 'and never the world-readable prefix');
  assert.match(fn, /fs\.existsSync/, 'the local R&D path still works');

  // The kept rows have to carry the answer in the first place.
  const cand = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  const kept = cand.slice(cand.indexOf('async function keptForExport'));
  assert.match(kept.slice(0, 600), /storage_key/);
});

test('the export produces the thing that trains a model, not a folder', () => {
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  const fn = ctl.slice(ctl.indexOf('exports.exportSet'), ctl.indexOf('exports.tenantQuote'));

  // fal FETCHES a zip. A path on a disk it cannot see is not a step towards one.
  assert.match(fn, /SeedExport\.publish/);
  assert.match(fn, /seed_set_url: seedSet\.url/);
  assert.ok(!/copyFileSync/.test(fn), 'copying frames into a folder on the API server is not an export');
  assert.ok(!/dir: seedDir/.test(fn), 'and a server filesystem path is not an answer to a customer');

  // The remedy it offers must be one a customer can act on.
  assert.ok(!/copy the candidates directory/i.test(fn),
    'a customer has no repository, no shell and no directory to copy');

  // The manifest travels INSIDE the archive. A seed set that cannot say what it
  // covered is one nobody can audit afterwards, and the coverage is the whole
  // argument for why these twelve frames and not twelve others.
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedExport.js')));
  const pub = svc.slice(svc.indexOf('async function publish'));
  assert.match(pub, /entries\.push\(\{ name: 'manifest\.json'/);
  assert.match(pub, /projectId: 'training'/, 'not the published-media prefix, which is world-readable');
  assert.match(pub, /contentType: 'application\/zip'/);
});

test('the archive is a real archive', () => {
  // Written by hand: no zip library is installed and shelling out to `zip` is a
  // dependency on whatever host the API runs on. PNG and JPEG are already
  // compressed, so STORE costs nothing and the bytes go in unchanged.
  const { buildZip } = require('../src/services/studio/seedExport');
  const zip = buildZip([
    { name: '0001-close-front-soft.png', data: Buffer.from('pretend-pixels') },
    { name: 'manifest.json', data: Buffer.from('{"count":1}') },
  ], { now: new Date('2026-09-10T12:34:56Z') });

  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50, 'local file header');
  assert.strictEqual(zip.readUInt16LE(8), 0, 'STORE, so the bytes are unchanged');

  // The end-of-central-directory record is what a reader finds first, and it
  // has to agree with what was written.
  const end = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(end), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(end + 8), 2, 'entries on this disk');
  assert.strictEqual(zip.readUInt16LE(end + 10), 2, 'entries in total');
  const cdSize = zip.readUInt32LE(end + 12);
  const cdOffset = zip.readUInt32LE(end + 16);
  assert.strictEqual(cdOffset + cdSize, end, 'the central directory must end where the record begins');
  assert.strictEqual(zip.readUInt32LE(cdOffset), 0x02014b50, 'central directory header');

  // Sizes are known before the write, so no data descriptor and no streaming
  // flag — a reader that trusts the header must find the truth there.
  assert.strictEqual(zip.readUInt16LE(6), 0, 'no general-purpose flags');
  assert.strictEqual(zip.readUInt32LE(18), 14, 'compressed size');
  assert.strictEqual(zip.readUInt32LE(22), 14, 'uncompressed size — identical under STORE');

  // A separator in a name is how an archive escapes its own directory.
  assert.throws(() => buildZip([{ name: '../escape.png', data: Buffer.from('x') }]), /flat/);
  assert.throws(() => buildZip([{ name: 'a\\\\b.png', data: Buffer.from('x') }]), /flat/);
});

test('the archive computes its own CRC, and gets it right', () => {
  // `zlib.crc32` arrived in Node 20.15 / 22.2. It was used here because it
  // existed on the machine the code was checked on, and the API server — an
  // older Node — answered `crc32 is not a function` on the first real export.
  // A zip is not worth a runtime-version dependency.
  const { crc32 } = require('../src/services/studio/seedExport');
  const of = (s) => crc32(Buffer.from(s));

  assert.strictEqual(of(''), 0x00000000, 'the empty case');
  assert.strictEqual(of('123456789'), 0xcbf43926, "the standard CRC-32 check value");
  assert.strictEqual(of('hello'), 0x3610a686);
  assert.strictEqual(of('The quick brown fox jumps over the lazy dog'), 0x414fa339);

  // Unsigned. A signed result writes a negative into a UInt32 field and throws,
  // or worse, wraps — and roughly half of all inputs land there.
  const big = Buffer.alloc(100_000);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  assert.ok(crc32(big) >= 0 && crc32(big) <= 0xffffffff);
  assert.strictEqual(crc32(big), crc32(big), 'and it is a function, not a stream');

  const src = read(path.join(ROOT, 'src', 'services', 'studio', 'seedExport.js'));
  assert.ok(!/require\('node:zlib'\)|require\("node:zlib"\)|zlib\.crc32\(/.test(strip(src)),
    'the archive writer must not reach for a zlib that may not have it');
});

test('nothing this pipeline runs on the server needs a Node newer than the floor', () => {
  // The floor is Node 18, which is what the codebase already requires by using
  // global `fetch`. It is declared in package.json now because nothing declared
  // it before, which is how a Node-20-only function shipped to a Node-18 server
  // and was found by a customer rather than by a test.
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.match(pkg.engines?.node || '', />=\s*18/, 'the floor has to be written down');

  const MODERN = [
    [/\bObject\.groupBy\b/, 'Object.groupBy (Node 21)'],
    [/\bPromise\.withResolvers\b/, 'Promise.withResolvers (Node 22)'],
    [/\bArray\.fromAsync\b/, 'Array.fromAsync (Node 22)'],
    [/\.toSorted\(/, 'Array.prototype.toSorted (Node 20)'],
    [/\.toReversed\(/, 'Array.prototype.toReversed (Node 20)'],
    [/\bzlib\.crc32\b|crc32 \} = require\('node:zlib'\)/, 'zlib.crc32 (Node 20.15)'],
  ];

  const files = [
    ['src', 'services', 'studio', 'seedExport.js'],
    ['src', 'services', 'studio', 'cloudRunner.js'],
    ['src', 'services', 'studio', 'jobResult.js'],
    ['src', 'services', 'studio', 'jobUpload.js'],
    ['src', 'services', 'studio', 'stageKinds.js'],
    ['src', 'services', 'studio', 'seedBatch.js'],
    ['src', 'services', 'studio', 'seedPrompt.js'],
    ['src', 'services', 'studio', 'seedCandidates.js'],
    ['src', 'controllers', 'studioCandidateController.js'],
    ['src', 'controllers', 'studioJobController.js'],
    ['worker', 'providers', 'fal.js'],
    ['src', 'app.js'],
  ];

  for (const rel of files) {
    const src = strip(read(path.join(ROOT, ...rel)));
    for (const [re, what] of MODERN) {
      assert.ok(!re.test(src), `${rel.join('/')} uses ${what}, which is above the declared floor`);
    }
  }
});

test('training reads the seed set from the database, not from a folder', () => {
  // `studio/train.js` read `studio/personas/<slug>/seed/` — the folder the old
  // export wrote by copying files around. Publishing a zip instead left that
  // folder unwritten, so the only path to a trained model had nothing to read.
  const cli = strip(read(path.join(ROOT, 'studio', 'train.js')));

  assert.match(cli, /Seed\.keptForExport\(pool, avatar\.tenant_id, avatar\.id\)/,
    'the kept rows ARE the decision; the folder was only ever a snapshot of one');
  assert.ok(!/personas', avatar\.slug, 'seed'/.test(cli),
    'nothing writes that folder any more');
  assert.match(cli, /mkdtempSync/, 'the embedder takes paths, so bytes go to a temp dir');
  assert.ok(!/execFileSync\('zip'/.test(cli), 'and it no longer shells out to zip');

  // One archive-builder, shared with the endpoint. The archive fal receives has
  // to be the same archive whichever way it was asked for.
  assert.match(cli, /SeedExport\.publish/);
  assert.match(cli, /SeedExport\.frameBytes/);
});

test('a JSX attribute is not a JavaScript string', () => {
  // `what="… how they look — then one button."` put six literal characters
  // on the Shoot screen. JSX attribute values are not JS string literals, so a
  // backslash escape in one is just a backslash. In a template literal it is a
  // real escape, which is why the same sequence renders correctly elsewhere.
  const files = ['app/avatars/[id]/shoot/page.jsx', 'app/insights/page.jsx',
                 'app/library/page.jsx', 'app/shoots/page.jsx',
                 'app/avatars/[id]/face/page.jsx'];
  for (const rel of files) {
    const src = read(path.join(FE, ...rel.split('/')));
    for (const m of src.matchAll(/\\u[0-9a-fA-F]{4}/g)) {
      // Allowed only inside a backtick string, where it actually escapes.
      const before = src.slice(0, m.index);
      const ticks = (before.match(/`/g) || []).length;
      assert.strictEqual(ticks % 2, 1,
        `${rel} has ${m[0]} outside a template literal — it will render as those six characters`);
    }
  }
});

test('the avatar card reports setting up, not just publishing', () => {
  // It read `assets ? `${assets} images` : 'No photos yet'`, and `assets` counts
  // SHOOT output. An avatar with twenty-four candidate frames, eighteen kept and
  // a face already chosen said "No photos yet" — true of a different thing, and
  // read as "nothing has happened" to somebody who had just spent an afternoon.
  const page = read(path.join(FE, 'app', 'avatars', 'page.jsx'));
  assert.ok(!/a\.assets \? `\$\{a\.assets\} images` : 'No photos yet'/.test(page),
    'the one line on the card cannot be about published output alone');
  assert.match(page, /function progress\(a\)/);

  // Run the real function over the states an avatar actually passes through.
  const src = page.match(/function progress\(a\)\s*\{[\s\S]*?\n\}/);
  assert.ok(src, 'the card line must be one testable function');
  const progress = new Function(`${src[0]}; return progress;`)();

  assert.strictEqual(progress({}), 'Nothing generated yet');
  assert.strictEqual(progress({ anchors: 6 }), '6 faces to choose between');
  assert.strictEqual(progress({ anchors: 6, anchor_chosen: true }), 'Face chosen — no photos yet');
  assert.strictEqual(progress({ anchors: 6, anchor_chosen: true, candidates: 24 }),
    '24 photos to choose from', 'the state the card used to call "No photos yet"');
  assert.strictEqual(progress({ candidates: 24, kept: 12 }), '12 of 24 photos kept');
  assert.strictEqual(progress({ trained: true }), 'Trained');
  assert.strictEqual(progress({ trained: true, assets: 40 }), 'Trained · 40 images');

  // Newest fact first: a trained avatar is not described by its seed set.
  assert.strictEqual(progress({ trained: true, candidates: 24, kept: 12, anchors: 6 }), 'Trained');
});

test('the counts behind the card are per kind and per tenant', () => {
  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const list = ctl.slice(ctl.indexOf('exports.list'), ctl.indexOf('exports.get'));

  assert.match(list, /COUNT\(\*\) FILTER \(WHERE kind = 'anchor'\)/);
  assert.match(list, /COUNT\(\*\) FILTER \(WHERE kind = 'pool'\)/,
    'six anchors must not inflate the number of photos to choose from');
  assert.match(list, /COUNT\(\*\) FILTER \(WHERE kind = 'pool' AND verdict = 'keep'\)/);
  assert.match(list, /FROM seed_candidates\s*\n?\s*WHERE tenant_id = \$1/,
    'the subquery is tenant-scoped on its own, not only through the join');
  assert.match(list, /anchor_candidate_id IS NOT NULL/);

  // One grouped pass rather than three subselects per row.
  assert.match(list, /LEFT JOIN \(/);
});
