'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Before anything requires the app: the register limiter is 5/hour/IP and this
// file signs up a dozen times from one address. Set here rather than in the test
// script so it cannot leak to a real run.
process.env.DISABLE_RATE_LIMIT = '1';
require('dotenv').config();

const pool = require('../src/config/db');
const sms  = require('../src/services/sms');

/**
 * Sign-up now takes two codes: email, then SMS. The account is created at the
 * end of the second one.
 *
 * The property worth protecting is not "the happy path works" — it is that an
 * unfinished sign-up leaves NOTHING behind. Before this change the user row was
 * created at the email step, so abandoning at the phone step would have left an
 * account that could sign in, held the email address so the person could not
 * retry, and carried an unverified number. Several tests here exist only to say
 * that cannot happen.
 *
 * SMS is stubbed by replacing the property on the module object. That only works
 * because the controller imports the namespace rather than destructuring; if
 * someone "tidies" that import back to `const { sendOtpOrFail } = require(...)`,
 * these tests keep passing while sending real messages, so the first test below
 * asserts the seam itself is still there.
 */

const app = require('../src/app');

let server, base;
const sent = [];                       // every SMS the code tried to send
const realSendOrFail = sms.sendOtpOrFail;

test.before(async () => {
  sms.sendOtpOrFail = async (to, code) => { sent.push({ to, code }); return { sent: true }; };
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  sms.sendOtpOrFail = realSendOrFail;
  await new Promise((r) => server.close(r));
  await pool.end();
});

let n = 0;
const uniq = () => { n += 1; return `${Date.now()}${n}`; };

async function post(path, body) {
  const res = await fetch(`${base}/api/auth/${path}`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3100' },
    body   : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json || {} };
}

/** Register and return the pending row, reading the codes straight from the DB. */
async function startSignup(overrides = {}) {
  const id = uniq();
  const payload = {
    name        : 'Test Person',
    email       : `t${id}@example.test`,
    password    : 'correct horse battery',
    phone_number: `+9198${String(id).slice(-8)}`,
    ...overrides,
  };
  const out = await post('register', payload);
  return { payload, out };
}

const pendingRow = async (id) =>
  (await pool.query('SELECT * FROM pending_registrations WHERE id = $1', [id])).rows[0];

const userByEmail = async (email) =>
  (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0] || null;

const cleanup = async (email) => {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email]);
};

// ─────────────────────────────────────────────────────────────────────────────

test('the SMS stub seam still exists (guards every test below)', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../src/controllers/authController'), 'utf8'
  );
  assert.ok(
    /const sms = require\('\.\.\/services\/sms'\)/.test(src),
    'authController must import the sms module as a namespace — a destructured '
    + 'import cannot be stubbed, and these tests would send real messages.'
  );
  assert.ok(/sms\.sendOtpOrFail\(/.test(src), 'sign-up must send through the strict path');
});

test('sign-up without a phone number is refused', async () => {
  const { out } = await startSignup({ phone_number: '' });
  assert.strictEqual(out.status, 400);
  assert.match(JSON.stringify(out.body), /mobile number|phone/i);
});

test('sign-up with an unparseable phone number is refused', async () => {
  const { out } = await startSignup({ phone_number: '12345' });
  assert.strictEqual(out.status, 400);
});

test('the email code sends an SMS and creates no account', async () => {
  const { payload, out } = await startSignup();
  assert.strictEqual(out.status, 201);
  const pendingId = out.body.pending_id;

  const before = sent.length;
  const row = await pendingRow(pendingId);
  const step = await post('verify-email', { pending_id: pendingId, code: row.otp_token });

  assert.strictEqual(step.status, 200);
  assert.strictEqual(step.body.next, 'phone', 'the response must say where to go next');
  assert.strictEqual(step.body.access_token, undefined, 'no session before the phone is verified');
  assert.strictEqual(sent.length, before + 1, 'exactly one SMS');

  // The point of the whole change.
  assert.strictEqual(await userByEmail(payload.email), null, 'no user row may exist yet');
  await cleanup(payload.email);
});

test('the masked hint does not leak the whole number', async () => {
  const { payload, out } = await startSignup();
  const row = await pendingRow(out.body.pending_id);
  const step = await post('verify-email', { pending_id: out.body.pending_id, code: row.otp_token });
  const hint = step.body.phone_hint || '';
  assert.ok(hint.includes('•'), `expected a masked hint, got ${hint}`);
  assert.ok(!hint.replace(/[^0-9]/g, '').includes(payload.phone_number.replace(/[^0-9]/g, '')),
    'the hint must not contain the full number');
  await cleanup(payload.email);
});

test('replaying the email code does not send a second SMS', async () => {
  const { payload, out } = await startSignup();
  const row = await pendingRow(out.body.pending_id);
  await post('verify-email', { pending_id: out.body.pending_id, code: row.otp_token });

  const before = sent.length;
  const again = await post('verify-email', { pending_id: out.body.pending_id, code: row.otp_token });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(sent.length, before, 'a replayed email code must not cost another message');
  await cleanup(payload.email);
});

test('a wrong SMS code creates nothing and counts the attempt', async () => {
  const { payload, out } = await startSignup();
  const pendingId = out.body.pending_id;
  const row = await pendingRow(pendingId);
  await post('verify-email', { pending_id: pendingId, code: row.otp_token });

  const bad = await post('verify-phone-signup', { pending_id: pendingId, code: '000000' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(await userByEmail(payload.email), null, 'a wrong code must not create an account');
  assert.strictEqual((await pendingRow(pendingId)).phone_attempts, 1);
  await cleanup(payload.email);
});

test('the phone step cannot be skipped past the email step', async () => {
  const { payload, out } = await startSignup();
  const pendingId = out.body.pending_id;

  // Straight to hop two without doing hop one.
  const jump = await post('verify-phone-signup', { pending_id: pendingId, code: '000000' });
  assert.strictEqual(jump.status, 400);
  assert.strictEqual(jump.body.next, 'email');
  assert.strictEqual((await pendingRow(pendingId)).phone_attempts, 0,
    'an out-of-order call must not burn an attempt');
  await cleanup(payload.email);
});

test('the correct SMS code creates the account, verified on both channels', async () => {
  const { payload, out } = await startSignup();
  const pendingId = out.body.pending_id;
  const row = await pendingRow(pendingId);
  await post('verify-email', { pending_id: pendingId, code: row.otp_token });

  const withOtp = await pendingRow(pendingId);
  const done = await post('verify-phone-signup', { pending_id: pendingId, code: withOtp.phone_otp });

  assert.strictEqual(done.status, 200);
  assert.ok(done.body.access_token, 'the session appears here and only here');

  const user = await userByEmail(payload.email);
  assert.ok(user, 'the account exists now');
  assert.strictEqual(user.email_verified, true);
  assert.strictEqual(user.phone_verified, true, 'verified because a code was actually checked');
  assert.strictEqual(await pendingRow(pendingId), undefined, 'the pending row is consumed');
  await cleanup(payload.email);
});

test('phone_verified is never set without a code being checked', async () => {
  // The old flow called markPhoneVerified for every sign-up, including ones with
  // no phone at all, which made the column mean "this row exists".
  const { payload, out } = await startSignup();
  const pendingId = out.body.pending_id;
  const row = await pendingRow(pendingId);
  await post('verify-email', { pending_id: pendingId, code: row.otp_token });
  assert.strictEqual(await userByEmail(payload.email), null);
  await cleanup(payload.email);
});

test('SMS failure answers 503 and leaves the sign-up resumable', async () => {
  const { payload, out } = await startSignup();
  const pendingId = out.body.pending_id;
  const row = await pendingRow(pendingId);

  const restore = sms.sendOtpOrFail;
  sms.sendOtpOrFail = async () => { const e = new Error('down'); e.code = 'SMS_UNAVAILABLE'; throw e; };
  const step = await post('verify-email', { pending_id: pendingId, code: row.otp_token });
  sms.sendOtpOrFail = restore;

  // 503 and not 400: the number is fine and the person did nothing wrong.
  assert.strictEqual(step.status, 503);
  const after = await pendingRow(pendingId);
  assert.ok(after, 'the pending row must survive so they can try again');
  assert.strictEqual(after.phone_otp, null, 'no code may be recorded that was never sent');
  await cleanup(payload.email);
});
