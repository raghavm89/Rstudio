const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ms = require('ms');
const { validationResult } = require('express-validator');
const pool = require('../config/db');
const { User, ROLES } = require('../models/user');
const VerificationCode = require('../models/verification');
const RefreshToken = require('../models/refreshToken');
// Imported as a namespace, not destructured. A destructured import binds the
// function at module load, so a test that replaces `sms.sendOtpOrFail` replaces
// something this file is no longer looking at — and the suite sends real SMS, or
// appears to pass while testing nothing. The indirection is the seam.
const sms = require('../services/sms');
const { sendVerificationOtp, sendPasswordResetEmail } = require('../services/brevo');
const asyncHandler = require('../middleware/asyncHandler');
const { audienceForRequest, ISSUER } = require('../services/audience');
const { appUrlForAudience } = require('../utils/siteUrl');
const Provisioning = require('../services/studio/provisioning');
const OAuthState = require('../services/oauthState');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BCRYPT_COST        = parseInt(process.env.BCRYPT_COST, 10) || 12;
const MAX_RESENDS        = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between resends

// Pre-computed bcrypt hash of an unguessable string. Used as a dummy comparison
// target so login response time doesn't reveal whether an email exists.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

function generateOtp() {
  // crypto.randomInt(min, max) — uniform, cryptographically secure
  return String(crypto.randomInt(100000, 1000000));
}

function otpExpiry() {
  return new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
}

function otpEmailExpiry() {
  return new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
}


// Phone parsing lives in src/utils/phone.js — the login rate limiter needs the
// same normalisation for its bucket key, and two copies would drift.
const { toE164, looksLikeEmail } = require('../utils/phone');

// Issues a short-lived access token (JWT) + long-lived refresh token (opaque).
// If `familyId` is provided, the new refresh token continues that family
// (rotation); otherwise a new family is started.
async function issueTokens(user, res, familyId = null, req = null, { audience = null } = {}) {
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id ?? null,
      // Which app this session belongs to. Derived from the request Origin,
      // never passed in — a caller that can nominate its own audience proves
      // nothing. Defaults to 'platform' so a missed call site keeps working.
      //
      // `audience` overrides it for exactly one case: an OAuth return, which has
      // no Origin of ours to read because the browser arrives by redirect from
      // the provider. That value does not come from the caller either — it comes
      // out of state we signed at the start of the flow, so it is still our
      // choice, just carried rather than re-derived.
      aud: audience || (req ? audienceForRequest(req) : 'platform'),
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m', issuer: ISSUER }
  );

  const refreshTtlMs = ms(process.env.JWT_REFRESH_EXPIRES_IN || '30d');
  if (typeof refreshTtlMs !== 'number') {
    throw new Error(`Invalid JWT_REFRESH_EXPIRES_IN: ${process.env.JWT_REFRESH_EXPIRES_IN}`);
  }
  const plainRefresh = crypto.randomBytes(40).toString('hex');
  const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

  if (familyId) {
    await RefreshToken.rotate(user.id, familyId, plainRefresh, refreshExpiresAt);
  } else {
    await RefreshToken.save(user.id, plainRefresh, refreshExpiresAt);
  }

  // Set refresh token as HttpOnly cookie — JS cannot read it
  res.cookie('refresh_token', plainRefresh, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires: refreshExpiresAt,
    path: '/api/auth',   // only sent to auth endpoints
  });

  return accessToken;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// POST /api/auth/register
// Validates the request and stores it in pending_registrations.
// No users row is created until the OTP is confirmed via /verify-email.
async function register(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { name, email, password, phone_number, address, role = 'tenant_user' } = req.body;

  // System admin and tenant_admin roles cannot be self-registered
  if (!ROLES.includes(role) || role === 'admin' || role === 'tenant_admin') {
    return res.status(400).json({ error: 'Role must be "tenant_user" or "developer" on self-registration' });
  }

  // Phone is required at sign-up and verified by SMS before the account exists.
  // The validator already rejects a missing one; this is the second check,
  // because the validator can be bypassed by any caller that reaches the
  // controller another way and a required field checked in exactly one place is
  // a required field until someone adds a second route.
  if (!phone_number || !phone_number.trim()) {
    return res.status(400).json({ error: 'A mobile number is required. Include the country code (e.g. +91 98765 43210).' });
  }
  const e164 = toE164(phone_number);
  if (!e164) {
    return res.status(400).json({ error: 'Invalid phone number. Include country code (e.g. +91 98765 43210).' });
  }

  // Reject if already a verified user
  const [existingEmail, existingPhone] = await Promise.all([
    User.findByEmail(email),
    User.findByPhone(e164),
  ]);
  if (existingEmail) return res.status(409).json({ error: 'Email already registered' });
  if (existingPhone) return res.status(409).json({ error: 'Phone number already registered' });

  const hashed = await bcrypt.hash(password, BCRYPT_COST);
  const otp     = generateOtp();
  const expires = otpEmailExpiry();

  // Which app this sign-up began at, from the Origin — never from the body, for
  // the same reason the token audience isn't: a caller that can nominate its own
  // audience proves nothing. Recorded now rather than derived at verification,
  // because verification is a separate request that can arrive from a different
  // tab, a link in the email, or a phone — and the two derivations disagreeing
  // would decide whether this person gets a workspace.
  const signupAudience = audienceForRequest(req);

  // Someone else is already part-way through a sign-up on this number.
  //
  // Checked here rather than left to the unique constraint because the upsert
  // below keys on EMAIL: a different email with the same number is not a
  // conflict it can resolve, so it would surface as a 23505 and a 500. Caught
  // early it is a sentence the person can act on, and nothing has been spent.
  const { rows: phoneHeld } = await pool.query(
    'SELECT email FROM pending_registrations WHERE phone_number = $1 AND email <> $2',
    [e164, email]
  );
  if (phoneHeld.length) {
    return res.status(409).json({
      error  : 'That number already has a sign-up in progress',
      message: 'Finish that one, or wait an hour for it to lapse and start again.',
      code   : 'PENDING_PHONE_TAKEN',
    });
  }

  // Upsert into pending_registrations — allows retrying registration with the
  // same email before verification (refreshes OTP and all fields).
  let rows;
  try {
    ({ rows } = await pool.query(
    `INSERT INTO pending_registrations
       (name, email, password_hash, phone_number, address, role, otp_token, otp_expires_at,
        resend_count, last_resent_at, signup_audience)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NOW(), $9)
     ON CONFLICT (email) DO UPDATE SET
       name          = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       phone_number  = EXCLUDED.phone_number,
       address       = EXCLUDED.address,
       role          = EXCLUDED.role,
       otp_token     = EXCLUDED.otp_token,
       otp_expires_at= EXCLUDED.otp_expires_at,
       resend_count  = 0,
       last_resent_at= NOW(),
       created_at    = NOW(),
       signup_audience = EXCLUDED.signup_audience
     RETURNING id, otp_expires_at`,
    [name, email, hashed, e164, address || null, role, otp, expires, signupAudience]
    ));
  } catch (err) {
    // The backstop for the race the check above cannot close: two registrations
    // for one number arriving together. One wins, and the loser is told the
    // truth instead of getting a 500.
    if (err.code === '23505' && String(err.constraint || '').includes('phone')) {
      return res.status(409).json({
        error  : 'That number already has a sign-up in progress',
        message: 'Finish that one, or wait an hour for it to lapse and start again.',
        code   : 'PENDING_PHONE_TAKEN',
      });
    }
    throw err;
  }
  const pendingId  = rows[0].id;
  const expiresAt  = rows[0].otp_expires_at;

  let emailSent = false;
  try {
    emailSent = await sendVerificationOtp({ toEmail: email, toName: name, otp });
  } catch (e) {
    console.error('[register] Failed to send OTP email:', e.message);
  }

  return res.status(201).json({
    message   : 'We sent a 6-digit code to your email. Enter it to complete registration.',
    email_sent: emailSent,
    pending_id: pendingId,
    expires_at: expiresAt,
  });
}

// POST /api/auth/verify-phone
// Completes signup — issues token pair on success
async function verifyPhone(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { user_id, code } = req.body;

  const record = await VerificationCode.findValid(user_id, code);
  if (!record) return res.status(400).json({ error: 'Invalid or expired verification code' });

  await VerificationCode.markUsed(record.id);
  const user = await User.markPhoneVerified(user_id);

  const access_token = await issueTokens(user, res, null, req);

  return res.json({ message: 'Phone verified successfully', access_token, user });
}

// POST /api/auth/resend-otp
async function resendOtp(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { user_id } = req.body;

  const user = await User.findById(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.phone_verified) return res.status(400).json({ error: 'Phone is already verified' });

  const code = generateOtp();
  await VerificationCode.create(user.id, code, otpExpiry());
  await sms.sendOtp(user.phone_number, code);

  return res.json({ message: 'Verification code resent' });
}

// ── Sign-up verification: two hops, one account ──────────────────────────────
//
// This used to be a single step — emailed code in, user row out. Phone is now
// mandatory and SMS-verified, so it is two, and the account is created at the
// END of the second one rather than the first.
//
// The ordering is the whole design. Creating the user after the email code and
// verifying the phone afterwards would be simpler to write and would mean a
// half-finished sign-up leaves behind an account that can sign in, holds the
// email address so the person cannot retry, and has an unverified number. So
// nothing is written until both codes are in.

const MAX_PHONE_ATTEMPTS = 5;

/** `+919876543210` → `+91 ••••• 43210`. Enough to recognise, not enough to leak. */
function maskPhone(e164) {
  if (!e164) return 'your phone';
  const tail = e164.slice(-5);
  const head = e164.slice(0, Math.max(0, e164.length - 5)).replace(/\d/g, '•');
  return `${head} ${tail}`;
}

/**
 * Has someone taken this email or number since the pending row was written?
 *
 * Checked twice — once at the email step and again just before the insert —
 * because there is a phone call's worth of time between them, and the unique
 * constraint catching it at the insert produces a 500 rather than an answer.
 */
async function conflictFor(pending) {
  const [byEmail, byPhone] = await Promise.all([
    User.findByEmail(pending.email),
    pending.phone_number ? User.findByPhone(pending.phone_number) : Promise.resolve(null),
  ]);
  if (byEmail) return 'Email already registered';
  if (byPhone) return 'Phone number already registered';
  return null;
}

// POST /api/auth/verify-email  { pending_id, code }
//
// Hop one. Proves the email, sends the SMS, and creates nothing. A person who
// closes the tab here has no account — which is the point.
async function verifyEmail(req, res) {
  const { pending_id, code } = req.body;
  if (!pending_id || !code) return res.status(400).json({ error: 'pending_id and code are required' });

  const { rows } = await pool.query('SELECT * FROM pending_registrations WHERE id = $1', [pending_id]);
  const pending = rows[0];
  if (!pending) return res.status(404).json({ error: 'Verification request not found or already completed' });

  if (pending.otp_token !== String(code)) return res.status(400).json({ error: 'Invalid verification code' });
  if (new Date(pending.otp_expires_at) <= new Date()) {
    return res.status(400).json({ error: 'Code has expired. Request a new one.' });
  }

  const conflict = await conflictFor(pending);
  if (conflict) {
    await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending_id]);
    return res.status(409).json({ error: conflict });
  }

  // Replay guard. A double-clicked button, a stale tab and a script all resend
  // the same email code, and every replay would otherwise cost another SMS.
  // While the phone code is still alive, say so instead of sending a new one.
  if (pending.email_verified_at && pending.phone_otp
      && pending.phone_otp_expires_at && new Date(pending.phone_otp_expires_at) > new Date()) {
    return res.json({
      message   : 'Email already verified. Enter the code we sent to your phone.',
      pending_id: pending.id,
      next      : 'phone',
      phone_hint: maskPhone(pending.phone_number),
      expires_at: pending.phone_otp_expires_at,
    });
  }

  const phoneOtp     = generateOtp();
  const phoneExpires = otpExpiry();

  // Sent BEFORE the row is marked. If the send fails, the person is left exactly
  // where they were — rather than on a screen that says "we texted you" about a
  // code that was never sent, with no way forward and no way to start again.
  try {
    await sms.sendOtpOrFail(pending.phone_number, phoneOtp);
  } catch (err) {
    if (err.code === 'SMS_BAD_NUMBER') {
      return res.status(400).json({
        error: 'That mobile number cannot receive SMS. Please register again with a different number.',
      });
    }
    // 503, not 400. The number is fine and the person did nothing wrong; this is
    // our outage, and a 400 would tell them to go and fix their own input.
    console.error('[verifyEmail] SMS send failed:', err.message);
    return res.status(503).json({
      error: 'We could not send the SMS code just now. Please try again in a moment.',
    });
  }

  await pool.query(
    `UPDATE pending_registrations
        SET email_verified_at    = COALESCE(email_verified_at, NOW()),
            phone_otp            = $2,
            phone_otp_expires_at = $3,
            phone_attempts       = 0
      WHERE id = $1`,
    [pending_id, phoneOtp, phoneExpires]
  );

  return res.json({
    message   : `We sent a 6-digit code to ${maskPhone(pending.phone_number)}.`,
    pending_id: pending.id,
    next      : 'phone',
    phone_hint: maskPhone(pending.phone_number),
    expires_at: phoneExpires,
  });
}

// POST /api/auth/verify-phone-signup  { pending_id, code }
//
// Hop two, and the only place a sign-up creates anything.
async function verifyPhoneSignup(req, res) {
  const { pending_id, code } = req.body;
  if (!pending_id || !code) return res.status(400).json({ error: 'pending_id and code are required' });

  const { rows: pendingRows } = await pool.query(
    'SELECT * FROM pending_registrations WHERE id = $1', [pending_id]
  );
  const pending = pendingRows[0];
  if (!pending) return res.status(404).json({ error: 'Verification request not found or already completed' });

  // Order matters: refuse an out-of-order call before spending an attempt on it.
  if (!pending.email_verified_at) {
    return res.status(400).json({ error: 'Verify your email first.', next: 'email' });
  }
  if (!pending.phone_otp) {
    return res.status(400).json({ error: 'No phone code has been sent yet.', next: 'email' });
  }
  if (pending.phone_attempts >= MAX_PHONE_ATTEMPTS) {
    // Six digits is a million combinations, which is only a wall if something is
    // counting. The row is dead rather than merely locked — an attacker who can
    // reset the counter by waiting has not been stopped.
    await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending_id]);
    return res.status(429).json({ error: 'Too many incorrect codes. Please register again.' });
  }
  if (new Date(pending.phone_otp_expires_at) <= new Date()) {
    return res.status(400).json({ error: 'Code has expired. Request a new one.' });
  }

  if (pending.phone_otp !== String(code)) {
    const { rows: bumped } = await pool.query(
      'UPDATE pending_registrations SET phone_attempts = phone_attempts + 1 WHERE id = $1 RETURNING phone_attempts',
      [pending_id]
    );
    const left = Math.max(0, MAX_PHONE_ATTEMPTS - (bumped[0]?.phone_attempts ?? MAX_PHONE_ATTEMPTS));
    return res.status(400).json({ error: 'Invalid verification code', attempts_remaining: left });
  }

  // Re-checked, because the email step's check is now minutes old.
  const conflict = await conflictFor(pending);
  if (conflict) {
    await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending_id]);
    return res.status(409).json({ error: conflict });
  }

  let user;
  try {
    user = await User.create({
      name        : pending.name,
      email       : pending.email,
      password_hash: pending.password_hash,
      phone_number: pending.phone_number,
      address     : pending.address,
      role        : pending.role,
      tenant_id   : null,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or phone already registered' });
    }
    throw err;
  }

  // Both flags are now earned. `markPhoneVerified` used to run here for every
  // sign-up including ones with no phone at all, which made `phone_verified`
  // mean "this row exists" rather than "we reached this person" — the exact
  // thing the column is for.
  await Promise.all([
    User.markEmailVerified(user.id),
    User.markPhoneVerified(user.id),
    pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending_id]),
  ]);

  // Studio is self-serve, so a Studio sign-up has to end with somewhere to work.
  // Every Studio table is scoped by tenant_id; a verified user with none signs
  // in perfectly and then owns nothing — no error, just an empty app.
  //
  // Runs BEFORE the token is minted so the token carries the new tenant_id.
  if (pending.signup_audience === 'studio') {
    try {
      await Provisioning.ensureWorkspace(user.id);
    } catch (err) {
      // The account is real and verified at this point — the rows are committed.
      // Failing the response now would tell the person their sign-up failed when
      // it did not, and a retry would hit "Email already registered".
      console.error('[verifyPhoneSignup] workspace provisioning failed:', err.message);
    }
  }

  const freshUser    = await User.findById(user.id);
  const access_token = await issueTokens(freshUser, res, null, req);

  return res.json({
    message: 'Verified. Your account is ready.',
    access_token,
    user: {
      id          : freshUser.id,
      name        : freshUser.name,
      email       : freshUser.email,
      phone_number: freshUser.phone_number,
      address     : freshUser.address,
      role        : freshUser.role,
      tenant_id   : freshUser.tenant_id  ?? null,
      tenant_name : freshUser.tenant_name ?? null,
    },
  });
}

// POST /api/auth/resend-phone-signup  { pending_id }
async function resendPhoneSignup(req, res) {
  const { pending_id } = req.body;
  if (!pending_id) return res.status(400).json({ error: 'pending_id is required' });

  const { rows } = await pool.query('SELECT * FROM pending_registrations WHERE id = $1', [pending_id]);
  const pending = rows[0];
  if (!pending) return res.status(404).json({ error: 'Verification request not found or already completed' });
  if (!pending.email_verified_at) {
    return res.status(400).json({ error: 'Verify your email first.', next: 'email' });
  }

  // Counted separately from the email resends. Sharing one counter would let
  // five email resends exhaust the phone budget of someone who has not reached
  // the phone step yet.
  if (pending.phone_resend_count >= MAX_RESENDS) {
    return res.status(429).json({
      error: 'Maximum resend attempts reached. Please register again.',
      resends_remaining: 0,
    });
  }

  const phoneOtp     = generateOtp();
  const phoneExpires = otpExpiry();
  try {
    await sms.sendOtpOrFail(pending.phone_number, phoneOtp);
  } catch (err) {
    console.error('[resendPhoneSignup] SMS send failed:', err.message);
    return res.status(503).json({ error: 'We could not send the SMS code just now. Please try again in a moment.' });
  }

  const { rows: updated } = await pool.query(
    `UPDATE pending_registrations
        SET phone_otp = $2, phone_otp_expires_at = $3,
            phone_attempts = 0, phone_resend_count = phone_resend_count + 1
      WHERE id = $1
      RETURNING phone_resend_count`,
    [pending_id, phoneOtp, phoneExpires]
  );

  return res.json({
    message          : `We sent a new code to ${maskPhone(pending.phone_number)}.`,
    expires_at       : phoneExpires,
    resends_remaining: Math.max(0, MAX_RESENDS - updated[0].phone_resend_count),
  });
}

// POST /api/auth/resend-verification  { pending_id }
async function resendVerification(req, res) {
  const { pending_id } = req.body;
  if (!pending_id) return res.status(400).json({ error: 'pending_id is required' });

  const { rows } = await pool.query(
    'SELECT * FROM pending_registrations WHERE id = $1',
    [pending_id]
  );
  const pending = rows[0];
  if (!pending) {
    return res.status(404).json({ error: 'Verification request not found or already completed' });
  }

  // Max resend attempts
  if (pending.resend_count >= MAX_RESENDS) {
    return res.status(429).json({
      error            : 'Maximum resend attempts reached. Please register again.',
      resends_remaining: 0,
    });
  }

  // Cooldown — must wait 60 s between resends
  if (pending.last_resent_at) {
    const elapsed = Date.now() - new Date(pending.last_resent_at).getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return res.status(429).json({
        error      : `Please wait ${waitSec}s before requesting a new code`,
        retry_after: waitSec,
      });
    }
  }

  const otp     = generateOtp();
  const expires = otpEmailExpiry();

  await pool.query(
    `UPDATE pending_registrations
     SET otp_token = $1, otp_expires_at = $2,
         resend_count = resend_count + 1, last_resent_at = NOW()
     WHERE id = $3`,
    [otp, expires, pending_id]
  );

  let emailSent = false;
  try {
    emailSent = await sendVerificationOtp({ toEmail: pending.email, toName: pending.name, otp });
  } catch (e) {
    console.error('[resendVerification] Failed to send OTP email:', e.message);
  }

  return res.json({
    message          : 'Verification code resent. Please check your inbox.',
    email_sent       : emailSent,
    resends_remaining: MAX_RESENDS - (pending.resend_count + 1),
    expires_at       : expires.toISOString(),
  });
}

// POST /api/auth/login
async function login(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  // `identifier` is the field the form sends now; `email` is still read so any
  // existing caller — an old tab, a script, the tests written before this — keeps
  // working rather than failing with "password is required" and no clue why.
  const { identifier, email, password } = req.body;
  const typed = String(identifier ?? email ?? '').trim();

  if (!typed) {
    return res.status(400).json({ error: 'Enter your email address or mobile number.' });
  }

  const byEmail = looksLikeEmail(typed);
  let user = null;
  let e164 = null;

  if (byEmail) {
    user = await User.findByEmail(typed.toLowerCase());
  } else {
    e164 = toE164(typed);
    if (!e164) {
      // 400 rather than 404: nothing was looked up, because this is not an
      // address or a number. "No account exists" would be a claim we have not
      // checked, and it would send them to sign-up with unusable input.
      return res.status(400).json({
        error: 'That is not an email address or a mobile number.',
        message: 'Enter the email you signed up with, or your mobile number with its country code.',
      });
    }
    user = await User.findByPhone(e164);
  }

  // `user.password_hash` is legitimately absent for an OAuth account, which has
  // no local password. bcrypt.compare throws on undefined — "Illegal arguments:
  // string, undefined" — which surfaces as a 500 and tells the person nothing.
  //
  // This used to read `user.password`, a column the live database did not have.
  // The result was not an error: every account looked like it had no local
  // password, so everyone with one was told their account was created with
  // Google. A wrong answer delivered confidently, which is worse than a crash.
  //
  // Falling back to the dummy hash keeps the uniform timing AND makes this a
  // normal failed login rather than a crash. `hasLocalPassword` then lets the
  // response say something true instead of "invalid credentials" to someone
  // whose credentials were never stored.
  const hasLocalPassword = Boolean(user && typeof user.password_hash === 'string' && user.password_hash);
  // Always run bcrypt to keep response time uniform whether the account exists or not.
  const match = await bcrypt.compare(password, hasLocalPassword ? user.password_hash : DUMMY_BCRYPT_HASH);

  if (!user) {
    // Was a sign-up started and never finished? Looked up by whichever field
    // they actually typed — searching pending rows by email when they gave a
    // phone number finds nothing and reports "no account" to someone who has a
    // half-finished one.
    const { rows: pending } = byEmail
      ? await pool.query('SELECT id FROM pending_registrations WHERE email = $1', [typed.toLowerCase()])
      : await pool.query('SELECT id FROM pending_registrations WHERE phone_number = $1', [e164]);

    const noun = byEmail ? 'email address' : 'mobile number';

    if (pending.length) {
      return res.status(404).json({
        error      : 'Sign-up not finished',
        message    : `A sign-up was started with this ${noun} but never verified. Start again to finish it.`,
        no_account : true,
        // So the form can put what they typed into the right box.
        identifier_kind: byEmail ? 'email' : 'phone',
      });
    }
    return res.status(404).json({
      error      : 'Account not found',
      message    : `No account exists with this ${noun}. Please create an account to get started.`,
      no_account : true,
      identifier_kind: byEmail ? 'email' : 'phone',
    });
  }

  if (user && !hasLocalPassword) {
    // Deliberately specific. The endpoint already reveals whether an email is
    // registered (it answers 404 + no_account for unknown ones), so naming the
    // sign-in method leaks nothing further — and without it, someone who signed
    // up with Google is told their correct password is wrong, forever.
    return res.status(409).json({
      error: 'This account has no password',
      message: 'This account was created with Google or GitHub sign-in. '
        + 'Use that button, or set a password with "Forgotten your password?".',
      code: 'NO_LOCAL_PASSWORD',
    });
  }

  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  /**
   * Only gate on a phone that exists.
   *
   * This used to refuse everyone with `phone_verified = false`, including
   * accounts with no number at all — every account created before phone
   * verification existed, and every OAuth account, since routes/oauth.js inserts
   * without one. Those people were told "Account not yet verified. Please
   * contact support." forever: no code could be sent, no screen could accept
   * one, and support had nothing to do either.
   *
   * "Verify your phone" is meaningless without a phone. They verified their
   * email, which was the whole requirement when they signed up, and a rule
   * introduced later does not get to lock them out retroactively.
   */
  if (user.phone_number && !user.phone_verified) {
    const code = generateOtp();
    await VerificationCode.create(user.id, code, otpExpiry());
    // Best-effort: if SMS is down they still see the screen and can resend,
    // which is better than a 503 on a correct password.
    await sms.sendOtp(user.phone_number, code);

    return res.status(403).json({
      error     : 'Phone number not verified',
      message   : `We sent a 6-digit code to ${maskPhone(user.phone_number)}.`,
      code      : 'PHONE_UNVERIFIED',
      user_id   : user.id,
      phone_hint: maskPhone(user.phone_number),
    });
  }

  const access_token = await issueTokens(user, res, null, req);

  return res.json({
    access_token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone_number: user.phone_number,
      address: user.address,
      role: user.role,
      tenant_id: user.tenant_id ?? null,
      tenant_name: user.tenant_name ?? null,
    },
  });
}

// POST /api/auth/refresh
// Client sends the HttpOnly cookie automatically; returns a new access token.
// Token-reuse detection: if a revoked token is presented, the entire family
// is revoked — this signals a stolen-token replay.
async function refresh(req, res) {
  const plainRefresh = req.cookies?.refresh_token;
  if (!plainRefresh) {
    return res.status(401).json({ error: 'Refresh token missing' });
  }

  const stored = await RefreshToken.findByToken(plainRefresh);
  if (!stored) {
    return res.status(401).json({ error: 'Refresh token invalid' });
  }

  // Replay of an already-rotated (revoked) token → kill the whole family.
  if (stored.revoked) {
    await RefreshToken.revokeFamily(stored.family_id);
    res.clearCookie('refresh_token', { path: '/api/auth' });
    return res.status(401).json({ error: 'Refresh token reuse detected; session terminated' });
  }

  if (new Date(stored.expires_at) <= new Date()) {
    return res.status(401).json({ error: 'Refresh token expired' });
  }

  // Rotate within the same family
  await RefreshToken.revoke(plainRefresh);

  const user = await User.findById(stored.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const access_token = await issueTokens(user, res, stored.family_id, req);

  return res.json({ access_token });
}

// POST /api/auth/logout
async function logout(req, res) {
  const plainRefresh = req.cookies?.refresh_token;
  if (plainRefresh) {
    await RefreshToken.revoke(plainRefresh);
  }
  res.clearCookie('refresh_token', { path: '/api/auth' });
  return res.json({ message: 'Logged out successfully' });
}

// POST /api/auth/logout-all  — revokes every session for this user
async function logoutAll(req, res) {
  await RefreshToken.revokeAll(req.user.id);
  res.clearCookie('refresh_token', { path: '/api/auth' });
  return res.json({ message: 'Logged out from all devices' });
}

// POST /api/auth/forgot-password
// Always responds 200 to prevent email enumeration.
async function forgotPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ error: errors.array()[0].msg });

  const { email } = req.body;
  const user = await User.findByEmail(email.toLowerCase().trim());

  if (user && user.email_verified) {
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await pool.query(
      `UPDATE users
         SET password_reset_token = $1, password_reset_expires_at = $2
       WHERE id = $3`,
      [token, expires, user.id]
    );

    // Point the link at the app they asked from. A Studio user reset their
    // password on Studio and should land back on Studio — the old line always
    // used APP_URL, so every Studio user was emailed a rstudio.app link to a
    // page Studio does not serve.
    //
    // Derived from the audience, which resolves the Origin against a configured
    // allowlist, and NOT from the Origin or Host directly: those are attacker
    // controlled, and a forged one would put a link to someone else's domain
    // inside a real user's password-reset email.
    const resetUrl = `${appUrlForAudience(audienceForRequest(req))}/reset-password?token=${token}`;
    await sendPasswordResetEmail({ toEmail: user.email, toName: user.name, resetUrl });
  }

  // Always return the same message regardless of whether the email exists
  return res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
}

// POST /api/auth/reset-password
async function resetPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ error: errors.array()[0].msg });

  const { token, password } = req.body;

  const { rows } = await pool.query(
    `SELECT id, name, email FROM users
      WHERE password_reset_token = $1
        AND password_reset_expires_at > NOW()`,
    [token]
  );

  if (!rows.length) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  const user = rows[0];
  const hashed = await bcrypt.hash(password, BCRYPT_COST);

  await pool.query(
    `UPDATE users
        SET password_hash = $1,
            password_reset_token = NULL,
            password_reset_expires_at = NULL
      WHERE id = $2`,
    [hashed, user.id]
  );

  // Invalidate all existing sessions so old devices are logged out
  await RefreshToken.revokeAll(user.id);

  return res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
}

// POST /api/auth/oauth/exchange  { code }
//
// The second half of an OAuth sign-in. The provider redirect carried a
// single-use code rather than a token; this trades it for a session.
//
// Being a normal same-origin POST is the point. The response body carries the
// access token instead of a URL, and the refresh cookie is set on the origin the
// person is actually on — which the redirect could not do, because during it the
// browser is on the BACKEND's origin, not the app's.
async function oauthExchange(req, res) {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });

  const claim = await OAuthState.redeemHandoff(code);
  // One message for expired, already-spent and never-existed. The caller does
  // the same thing in every case, and distinguishing them tells someone probing
  // codes whether they were close.
  if (!claim) {
    return res.status(400).json({
      error: 'That sign-in link has expired or was already used. Please sign in again.',
      code : 'HANDOFF_INVALID',
    });
  }

  const user = await User.findById(claim.user_id);
  if (!user) return res.status(401).json({ error: 'Account not found' });

  const access_token = await issueTokens(user, res, null, req, { audience: claim.audience });

  return res.json({
    access_token,
    user: {
      id         : user.id,
      name       : user.name,
      email      : user.email,
      role       : user.role,
      tenant_id  : user.tenant_id ?? null,
      tenant_name: user.tenant_name ?? null,
    },
  });
}

module.exports = {
  register:            asyncHandler(register),
  oauthExchange:       asyncHandler(oauthExchange),
  verifyEmail:         asyncHandler(verifyEmail),
  resendVerification:  asyncHandler(resendVerification),
  verifyPhone:         asyncHandler(verifyPhone),
  verifyPhoneSignup:   asyncHandler(verifyPhoneSignup),
  resendPhoneSignup:   asyncHandler(resendPhoneSignup),
  resendOtp:           asyncHandler(resendOtp),
  login:               asyncHandler(login),
  refresh:             asyncHandler(refresh),
  logout:              asyncHandler(logout),
  logoutAll:           asyncHandler(logoutAll),
  forgotPassword:      asyncHandler(forgotPassword),
  resetPassword:       asyncHandler(resetPassword),
};
