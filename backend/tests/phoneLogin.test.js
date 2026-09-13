'use strict';

// The login limiter is 5 per 15 minutes per identity, and this file signs in
// more than that. Set before anything requires the app.
process.env.DISABLE_RATE_LIMIT = '1';
require('dotenv').config();

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const bcrypt = require('bcrypt');

const pool = require('../src/config/db');
const { toE164, identityKey } = require('../src/utils/phone');
const app  = require('../src/app');

/**
 * Sign-in accepts an email address or a mobile number.
 *
 * Two things here are worth more than the happy path:
 *
 * 1. Accounts that predate the phone requirement have `phone_number = NULL`.
 *    They must keep signing in by email forever. A regression here locks out
 *    every existing user, and it would not show up in a test that only creates
 *    fresh accounts.
 *
 * 2. The number a person types is not the number in the database. "9876543210",
 *    "+91 98765 43210" and "098765 43210" are one account, and all three have to
 *    find it — that is the entire feature, not a nicety.
 */

let server, base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const PASSWORD = 'correct horse battery';
const made = [];
let n = 0;

/** A verified account, inserted directly — this file tests login, not sign-up. */
async function makeUser({ withPhone = true } = {}) {
  n += 1;
  const tag   = `${Date.now()}${n}`;
  const email = `login${tag}@example.test`;
  // 9-prefixed 10-digit numbers are valid Indian mobiles; keep them unique.
  const national = `98${String(tag).slice(-8)}`;
  const phone = withPhone ? toE164(national) : null;
  const hash  = await bcrypt.hash(PASSWORD, 10);

  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, phone_number, role, email_verified, phone_verified)
     VALUES ($1, $2, $3, $4, 'tenant_user', TRUE, TRUE) RETURNING id`,
    ['Login Test', email, hash, phone]
  );
  made.push(rows[0].id);
  return { id: rows[0].id, email, phone, national };
}

test.after(async () => {
  if (made.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]);
});

async function login(body) {
  const res = await fetch(`${base}/api/auth/login`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3100' },
    body   : JSON.stringify({ password: PASSWORD, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

// ─────────────────────────────────────────────────────────────────────────────

test('signing in by email still works', async () => {
  const u = await makeUser();
  const out = await login({ identifier: u.email });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.access_token);
  assert.strictEqual(out.body.user.email, u.email);
});

test('the old `email` field is still accepted', async () => {
  // An open tab loaded before this deploy sends `email`, not `identifier`.
  const u = await makeUser();
  const out = await login({ email: u.email });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
});

test('signing in by phone works in every spelling of the number', async () => {
  const u = await makeUser();
  const national = u.national;                       // 9812345678
  const spellings = [
    u.phone,                                          // +919812345678
    national,                                         // 9812345678
    `0${national}`,                                   // 0 prefix, as printed on bills
    `+91 ${national.slice(0, 5)} ${national.slice(5)}`, // spaced
  ];
  for (const typed of spellings) {
    const out = await login({ identifier: typed });
    assert.strictEqual(out.status, 200, `${typed} → ${JSON.stringify(out.body)}`);
    assert.strictEqual(out.body.user.id, u.id, `${typed} found the wrong account`);
  }
});

test('an account with no phone number still signs in by email', async () => {
  // Every account created before phone became mandatory looks like this.
  const u = await makeUser({ withPhone: false });
  const out = await login({ identifier: u.email });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
});

test('a wrong password fails the same way for both identifier kinds', async () => {
  const u = await makeUser();
  for (const id of [u.email, u.national]) {
    const res = await fetch(`${base}/api/auth/login`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ identifier: id, password: 'wrong' }),
    });
    assert.strictEqual(res.status, 401, `${id} should be 401`);
  }
});

test('an unknown number says "number", an unknown email says "email"', async () => {
  const byPhone = await login({ identifier: '+919000000001' });
  assert.strictEqual(byPhone.status, 404);
  assert.strictEqual(byPhone.body.no_account, true);
  assert.strictEqual(byPhone.body.identifier_kind, 'phone');
  assert.match(byPhone.body.message, /mobile number/i);

  const byEmail = await login({ identifier: `nobody${Date.now()}@example.test` });
  assert.strictEqual(byEmail.status, 404);
  assert.strictEqual(byEmail.body.identifier_kind, 'email');
  assert.match(byEmail.body.message, /email address/i);
});

test('unparseable input is 400, not a 404 claiming we looked', async () => {
  // "No account exists" would be a claim about a lookup that never happened,
  // and it would send them to sign-up holding unusable input.
  for (const junk of ['garbage', '12345', '!!!']) {
    const out = await login({ identifier: junk });
    assert.strictEqual(out.status, 400, `${junk} → ${out.status}`);
  }
});

test('an empty identifier is refused without touching the database', async () => {
  const out = await login({ identifier: '   ' });
  assert.strictEqual(out.status, 400);
});

test('every spelling of one number shares one rate-limit bucket', async () => {
  // Not an HTTP test: the limiter is disabled here. This asserts the key
  // function directly, because a key that varies with formatting turns a
  // 5-attempt limit into 15 for anyone who alternates spellings.
  const keys = new Set(
    ['9812345678', '+919812345678', '0 98123 45678', '+91 98123 45678'].map(identityKey)
  );
  assert.strictEqual(keys.size, 1, `expected one bucket, got ${[...keys].join(', ')}`);

  assert.strictEqual(identityKey('A@B.com'), identityKey(' a@b.com '), 'email case must collapse');
  // Unparseable values must not all collapse onto '' — that is its own lockout.
  assert.notStrictEqual(identityKey('garbage'), identityKey('rubbish'));
});
