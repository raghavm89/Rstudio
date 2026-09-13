'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * A session that dies while the tab is open must end at the sign-in screen.
 *
 * What it did instead: the API cleared localStorage on a 401 and told React
 * nothing. The provider carried on holding a `user` object from before, its
 * redirect guard saw that user and concluded there was nothing to do, and the
 * page printed the backend's own words — "Missing or invalid Authorization
 * header" — beside a sidebar still showing the signed-in account.
 *
 * Three things had to be true and only two were. The guard was never wrong;
 * nothing had told it.
 *
 * The second half is the tab nobody touches. A 401 only happens if something
 * asks the server a question, and most screens stop asking once loaded — so an
 * expired session stayed invisible until a click.
 */

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const API      = () => read(path.join(FE, 'lib', 'api.js'));
const PROVIDER = () => read(path.join(FE, 'components', 'AuthProvider.jsx'));

/**
 * Run the REAL `tokenExpiry` from the shipped file.
 *
 * lib/api.js is an ES module in a package with no `"type": "module"`, so it
 * cannot simply be required here. Lifting the function out of the source and
 * running it is uglier than an import and much better than a regex: it tests
 * what actually ships, including the cases below that a regex could not see.
 */
function loadTokenExpiry() {
  const src = API();
  const body = src.slice(src.indexOf('export function tokenExpiry'),
                         src.indexOf('export async function ensureSession'));
  assert.ok(body.includes('tokenExpiry'), 'could not find tokenExpiry to test');
  return new Function('session', 'atob',
    `${body.replace('export function', 'return function')}; return tokenExpiry;`
  )({ token: () => null }, globalThis.atob);
}

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('tokenExpiry reads a real token and refuses to guess at a broken one', () => {
  const tokenExpiry = loadTokenExpiry();
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;

  assert.strictEqual(tokenExpiry(jwt({ exp: inAnHour })), inAnHour * 1000, 'seconds must become milliseconds');

  // Base64URL: a payload containing - or _ is normal and must still parse.
  assert.strictEqual(typeof tokenExpiry(jwt({ exp: inAnHour, sub: 'a-b_c' })), 'number');

  // Everything unreadable returns null, which `ensureSession` treats as "not my
  // business" rather than "expired". Guessing expired here would sign people out
  // over a token format nobody anticipated.
  for (const bad of [jwt({ sub: 1 }), 'garbage', '', null, undefined, 'a.b']) {
    assert.strictEqual(tokenExpiry(bad), null, `${String(bad).slice(0, 12)} should be null`);
  }
});

test('ensureSession renews before it gives up', () => {
  const src = strip(API());
  const fn = src.slice(src.indexOf('export async function ensureSession'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // Order is the whole point: an expired ACCESS token usually sits beside a
  // perfectly good refresh cookie, and signing someone out without trying it
  // would end every long session an hour early.
  const tryIdx  = body.indexOf('refreshOnce');
  const giveIdx = body.indexOf('emitSessionLost');
  assert.ok(tryIdx > -1,  'ensureSession must attempt a refresh');
  assert.ok(giveIdx > -1, 'ensureSession must give up when refresh fails');
  assert.ok(tryIdx < giveIdx, 'it must try to renew BEFORE declaring the session lost');

  // And renew early, so an open tab never serves a 401 at all.
  assert.match(src, /RENEW_MARGIN_MS\s*=\s*60_?000/, 'expected a renewal margin ahead of expiry');
});

test('only one refresh can be in flight', () => {
  // Refresh tokens rotate and the backend revokes a family on reuse. Two
  // concurrent refreshes are a token replay by our own client — it would sign
  // the person out for real, which is the opposite of the intent.
  const src = strip(API());
  assert.match(src, /let inFlight = null;/, 'no single-flight lock on refresh');
  assert.match(src, /function refreshOnce\(\)/);
  const calls = [...src.matchAll(/await refresh\(\)/g)];
  assert.strictEqual(calls.length, 0, 'callers must go through refreshOnce, not refresh directly');
});

test('the heartbeat catches a machine waking from sleep', () => {
  const src = strip(PROVIDER());
  // A sleeping machine runs no timers, so the interval alone is not enough: a
  // tab waking after four hours has one that never fired and a token that
  // expired two hours ago.
  // Matched on addEventListener specifically: `/visibilitychange/` alone also
  // matches the removeEventListener in the cleanup, so deleting the subscription
  // and keeping the teardown would have passed.
  assert.match(src, /addEventListener\('visibilitychange'/, 'no check when the tab becomes visible again');
  assert.match(src, /addEventListener\('focus'/, 'no check when the window regains focus');
  assert.match(src, /setInterval\(check/,        'no periodic check for a watched but idle tab');
  assert.match(src, /ensureSession\(\)/,         'the heartbeat must call ensureSession');

  // Not on the landing or sign-in screens, where there is no session to keep.
  const hb = src.slice(src.indexOf('const check ='));
  assert.ok(src.slice(0, src.indexOf('const check =')).includes('if (isPublic(pathname)) return undefined;'),
    'the heartbeat should stand down on public routes');
  assert.match(hb, /removeEventListener/, 'listeners must be torn down');
  assert.match(hb, /clearInterval/,       'the interval must be cleared');
});

test('signing out in one tab closes the others', () => {
  const src = strip(PROVIDER());
  assert.match(src, /addEventListener\('storage'/, 'no cross-tab listener');
  const st = src.slice(src.indexOf("addEventListener('storage'"));
  assert.ok(!/setUser\(null\)/.test(st.slice(0, 5)) , 'sanity');
  const handler = src.slice(src.indexOf('const onStorage'), src.indexOf("addEventListener('storage'"));
  assert.match(handler, /setUser\(null\)/, 'the other tabs must drop their user');
});

test('a 401 announces itself, not just clears storage', () => {
  const api = strip(API());
  assert.match(api, /export function onSessionLost/, 'nothing can subscribe to a lost session');

  const block = api.slice(api.indexOf('if (res.status === 401)'));
  const head  = block.slice(0, 400);
  assert.match(head, /session\.clear\(\)/,  'the 401 path should still clear the session');
  assert.match(head, /emitSessionLost\(\)/, 'the 401 path must also announce it');
});

test('the provider listens, and drops the stale user', () => {
  const src = strip(PROVIDER());
  assert.match(src, /onSessionLost/, 'the provider does not subscribe');
  const sub = src.slice(src.indexOf('onSessionLost('));
  assert.match(sub.slice(0, 200), /setUser\(null\)/, 'the listener must clear the user');

  // And the gate must still key on `user`, or clearing it achieves nothing.
  assert.match(src, /if \(!ready \|\| isPublic\(pathname\) \|\| user\) return;/);
  assert.match(src, /router\.replace\(`\/login\?next=/, 'the redirect should carry where they were going');
});

test('the account pages do not render auth errors themselves', () => {
  for (const page of ['account', 'billing', 'usage']) {
    const src = read(path.join(FE, 'app', page, 'page.jsx'));
    assert.match(src, /useResource\(/, `${page} should load through useResource`);
    assert.match(src, /<Resource state=/, `${page} should render through Resource`);
  }
});

test('the shell shows nothing signed-in once the user is gone', () => {
  const src = strip(read(path.join(FE, 'components', 'Shell.jsx')));
  assert.match(src, /if \(!signedIn\) return/, 'the shell must stand down when signed out');
});

test('Resource says where it is taking you, and does not re-implement sign-in', () => {
  const src = read(path.join(FE, 'components', 'Guard.jsx'));
  assert.match(src, /needsSignIn/, 'useResource must recognise an auth failure');
  assert.match(src, /signed-out/,  'and have a state for it');
  assert.ok(!/type="password"/.test(src), 'Guard should not contain a sign-in form');
});
