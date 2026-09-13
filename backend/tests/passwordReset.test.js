'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * The password-reset journey, checked where it was broken.
 *
 * It was broken in three independent places at once — the sign-in link pointed
 * at a page that did not exist, the API client had no methods for either
 * endpoint, and the emailed link went to a scheme-less host and a route Studio
 * did not serve. Fixing any one of them would not have revealed the other two,
 * which is exactly the shape of failure a test suite is for.
 */

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

test('every page the auth screens link to exists', () => {
  // The sign-in screen has linked to /forgot-password since it was written, and
  // the page was never built — a 404 sitting in plain sight on the busiest
  // screen in the product.
  const linked = new Set();
  for (const f of ['AuthScreen.jsx', 'ForgotPassword.jsx', 'ResetPassword.jsx']) {
    const src = read(path.join(FE, 'components', f));
    for (const m of src.matchAll(/href="(\/[a-z0-9/-]*)"/g)) linked.add(m[1]);
  }
  const missing = [...linked].filter((route) => {
    if (route === '/') return !exists(path.join(FE, 'app', 'page.jsx'));
    return !exists(path.join(FE, 'app', route.replace(/^\//, ''), 'page.jsx'));
  });
  assert.deepStrictEqual(missing, [], `auth screens link to routes with no page: ${missing.join(', ')}`);
});

test('the api client can actually reach both reset endpoints', () => {
  const src = read(path.join(FE, 'lib', 'auth.js'));
  assert.match(src, /call\('forgot-password'/, 'no client method calls /api/auth/forgot-password');
  assert.match(src, /call\('reset-password'/,  'no client method calls /api/auth/reset-password');
});

test('reset does not hand out a session', () => {
  // Proving you can read an inbox is not proving you know the password. Signing
  // someone in straight from an emailed link turns a forwarded message into an
  // account takeover.
  const src = read(path.join(FE, 'lib', 'auth.js'));
  const fn = src.slice(src.indexOf('resetPassword(token'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.ok(!/session\.set/.test(body), 'resetPassword must not set a session');
});

test('the emailed link is built from configuration, never from the request', () => {
  const src = read(path.join(ROOT, 'src', 'controllers', 'authController.js'));
  const line = src.split('\n').find((l) => l.includes('/reset-password?token='));
  assert.ok(line, 'no reset URL is built');
  // Host/Origin headers are attacker-controlled. Building the link from one puts
  // a link to someone else's domain inside a real user's reset email — a
  // phishing message sent over our own sending reputation.
  assert.ok(
    !/req\.(headers|get\()/.test(line),
    'the reset URL must not be built from request headers'
  );
  assert.match(line, /appUrlForAudience/, 'the reset URL should be chosen by audience');
});

test('a scheme-less APP_URL still produces an absolute link', () => {
  // APP_URL is routinely set as "rstudio.app". Unnormalised that is a relative
  // path to res.redirect and unlinkable to most mail clients.
  const { siteUrl, appUrlForAudience } = require('../src/utils/siteUrl');
  assert.strictEqual(siteUrl('rstudio.app'), 'https://rstudio.app');
  assert.strictEqual(siteUrl('https://x.com/'), 'https://x.com');

  const before = process.env.APP_URL;
  process.env.APP_URL = 'rstudio.app';
  assert.match(appUrlForAudience('platform'), /^https:\/\//, 'platform url must be absolute');
  process.env.APP_URL = before;
});

test('one password minimum, everywhere', () => {
  const routes = read(path.join(ROOT, 'src', 'routes', 'auth.js'));
  const userCtl = read(path.join(ROOT, 'src', 'controllers', 'userController.js'));
  const screen  = read(path.join(FE, 'components', 'AuthScreen.jsx'));
  const reset   = read(path.join(FE, 'components', 'ResetPassword.jsx'));

  // Only the `password` field — `code` and `phone_number` have their own lengths.
  const mins = [...routes.matchAll(/body\('password'\)\.isLength\(\{ min: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(mins.length >= 2, 'expected register and reset to both bound the password length');
  assert.deepStrictEqual([...new Set(mins)], [8], `validators disagree: ${mins.join(', ')}`);

  assert.match(userCtl, /new_password\.length < 8/, 'change-password must use the same minimum');
  assert.match(screen,  /At least 8 characters/,    'the sign-up hint must state the real rule');
  assert.match(reset,   /MIN_LENGTH = 8/,           'the reset screen must state the real rule');
});

test('the auth screens share one frame', () => {
  // Four screens, one shell. Two ways to build an auth page is how the masthead
  // and the plate drift apart one fix at a time.
  for (const f of ['AuthScreen.jsx', 'ForgotPassword.jsx', 'ResetPassword.jsx']) {
    const src = read(path.join(FE, 'components', f));
    assert.match(src, /AuthShell/, `${f} should render inside AuthShell`);
  }
});
