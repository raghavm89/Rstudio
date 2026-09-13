'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-only-secret';

const pool = require('../../src/config/db');
const OAuthState = require('../../src/services/oauthState');

/**
 * Two claims are made by this file, and both are load-bearing.
 *
 * 1. `state` is unforgeable, so the audience it carries is our decision rather
 *    than the caller's. Everywhere else the audience comes from the request
 *    Origin; an OAuth callback has no Origin of ours to read, so signed state is
 *    the only honest substitute.
 *
 * 2. A handoff code works exactly once. It is the thing that appears in a URL,
 *    so it must be worthless the moment it has been used, and worthless after a
 *    minute and a half whether it was used or not.
 */

let USER;

test.before(async () => {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password, role, phone_verified, email_verified)
     VALUES ('OAuth Tester', $1, 'x', 'tenant_user', TRUE, TRUE) RETURNING id`,
    [`oauth-${Math.random().toString(36).slice(2, 10)}@example.test`]
  );
  USER = rows[0].id;
});

test.after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  await pool.end();
});

// ── State ─────────────────────────────────────────────────────────────────────

test('state round-trips the app it was minted for', async () => {
  assert.strictEqual(OAuthState.verify(OAuthState.create('studio')), 'studio');
  assert.strictEqual(OAuthState.verify(OAuthState.create('platform')), 'platform');
});

test('an unknown app falls back to platform rather than being carried through', async () => {
  // `?app=` is read from a query string. Echoing an arbitrary value into the
  // audience would let a link decide which app a token is good for.
  assert.strictEqual(OAuthState.verify(OAuthState.create('wordpress')), 'platform');
  assert.strictEqual(OAuthState.verify(OAuthState.create(undefined)), 'platform');
});

test('🔒 a tampered audience does not verify', async () => {
  // The whole point. If the payload could be edited in flight, someone could
  // turn a platform sign-in into a Studio one by editing a URL.
  const state = OAuthState.create('platform');
  const [payload, sig] = state.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.a = 'admin';
  const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;

  assert.strictEqual(OAuthState.verify(forged), null);
});

test('🔒 state signed with a different secret does not verify', async () => {
  const real = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = 'someone-elses-secret';
  const theirs = OAuthState.create('studio');
  process.env.JWT_ACCESS_SECRET = real;

  assert.strictEqual(OAuthState.verify(theirs), null);
});

test('expired state does not verify', async () => {
  const payload = Buffer.from(JSON.stringify({ a: 'studio', n: 'x', e: Date.now() - 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_ACCESS_SECRET).update(payload).digest('base64url');
  assert.strictEqual(OAuthState.verify(`${payload}.${sig}`), null);
});

test('missing or malformed state does not verify, and does not throw', async () => {
  // A callback with no state is the current behaviour of every link already in
  // the wild, and the case an attacker constructs. It has to be a clean refusal,
  // not a 500 that some proxy turns into a retry.
  for (const bad of [undefined, null, '', 'nonsense', 'a.b.c', '.', 12345, {}]) {
    assert.strictEqual(OAuthState.verify(bad), null, `${JSON.stringify(bad)} should not verify`);
  }
});

test('each state is unique, so one cannot be replayed as another', async () => {
  const seen = new Set(Array.from({ length: 50 }, () => OAuthState.create('studio')));
  assert.strictEqual(seen.size, 50);
});

// ── Handoff ───────────────────────────────────────────────────────────────────

test('a handoff code redeems once and carries its audience', async () => {
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'studio', provider: 'google' });
  const claim = await OAuthState.redeemHandoff(code);

  assert.strictEqual(claim.user_id, USER);
  assert.strictEqual(claim.audience, 'studio');
  assert.strictEqual(claim.provider, 'google');
});

test('🔒 the same code cannot be redeemed twice', async () => {
  // This is what makes it safe to put in a URL. A code in someone's history or
  // in a proxy log is a code that has already been spent.
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'studio', provider: 'google' });
  assert.ok(await OAuthState.redeemHandoff(code));
  assert.strictEqual(await OAuthState.redeemHandoff(code), null);
});

test('🔒 two simultaneous redemptions mint exactly one session', async () => {
  // A double-submitting page, or React StrictMode running an effect twice. The
  // single UPDATE ... WHERE used_at IS NULL is what settles it; a read-then-write
  // would let both callers through.
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'studio', provider: 'github' });
  const [a, b] = await Promise.all([OAuthState.redeemHandoff(code), OAuthState.redeemHandoff(code)]);
  assert.strictEqual([a, b].filter(Boolean).length, 1);
});

test('🔒 the plaintext code is never stored', async () => {
  // A database dump should not contain anything that can be replayed into
  // someone's session — the same rule the refresh tokens follow.
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'studio', provider: 'google' });
  const { rows } = await pool.query('SELECT code_hash FROM oauth_handoff_codes WHERE user_id = $1', [USER]);
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((r) => r.code_hash === code), 'the code itself is in the table');
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)), 'stored value should be a sha256 hex digest');
});

test('an expired code does not redeem', async () => {
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'studio', provider: 'google' });
  await pool.query(
    "UPDATE oauth_handoff_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1 AND used_at IS NULL",
    [USER]
  );
  assert.strictEqual(await OAuthState.redeemHandoff(code), null);
});

test('a made-up code redeems to nothing rather than erroring', async () => {
  for (const bad of ['', null, undefined, 'not-a-real-code', crypto.randomBytes(32).toString('base64url')]) {
    assert.strictEqual(await OAuthState.redeemHandoff(bad), null);
  }
});

test('an unknown audience on a handoff is stored as platform, not rejected silently', async () => {
  // The CHECK constraint would otherwise turn a programming slip into a 500 in
  // the middle of someone's sign-in. Narrowing to the default keeps them signed
  // in with the least privilege rather than not at all.
  const code = await OAuthState.createHandoff({ userId: USER, audience: 'nonsense', provider: 'google' });
  const claim = await OAuthState.redeemHandoff(code);
  assert.strictEqual(claim.audience, 'platform');
});
