const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { identityKey } = require('../utils/phone');

const jsonError = (message) => (req, res) => res.status(429).json({ error: message });

/**
 * Off only when explicitly asked, and never by accident.
 *
 * The integration tests drive sign-up a dozen times from one address, which the
 * register limiter is correctly built to stop. Keyed to an explicit variable
 * rather than to NODE_ENV: 'test' is a value a deployment can carry for
 * unrelated reasons, and the failure mode of getting this wrong is a production
 * server with no rate limiting and no symptom until someone notices the bill.
 */
const skip = () => process.env.DISABLE_RATE_LIMIT === '1';

// Login: 5 attempts / 15 min / IP — keyed by IP+email so attackers can't lock a user out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  // Sign-in accepts an email or a mobile number, and this keyed on `email`
  // alone. A phone sign-in would have fallen through to the empty string, so
  // every phone login from one IP would share one bucket — five attempts per
  // fifteen minutes across every user on that address, which behind carrier NAT
  // is a lockout caused by strangers.
  //
  // Lower-cased and trimmed so `A@b.com` and `a@b.com ` are one bucket rather
  // than two; a key an attacker can vary for free is not a limit.
  // Normalised, not merely lower-cased: "9876543210", "+91 98765 43210" and
  // "098765 43210" are one account and must be one bucket. Keyed on the raw
  // string they would be three, and the five-attempt limit would really be
  // fifteen to anyone who varies the spacing.
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip)}:${identityKey(req.body?.identifier ?? req.body?.email)}`,
  handler: jsonError('Too many login attempts. Try again in 15 minutes.'),
});

// Register: 5 / hour / IP — protects against signup spam.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  handler: jsonError('Too many accounts created from this IP. Try again later.'),
});

// OTP verify: 6 / 10 min / user — bounds brute-force of the 6-digit code.
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  // `user_id` is the key for verifying a phone on an EXISTING account. Sign-up
  // has no user yet — it carries `pending_id` — so every sign-up verification
  // used to fall through to the literal string 'anon' and share one bucket per
  // IP. Behind carrier-grade NAT, which is most mobile traffic in India, that is
  // six verification attempts per ten minutes shared across every stranger on
  // the same carrier: real users locked out of sign-up by other real users, with
  // nothing in the logs to say why.
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip)}:${req.body?.user_id || req.body?.pending_id || 'anon'}`,
  handler: jsonError('Too many verification attempts. Request a new code.'),
});

// OTP resend: 3 / 10 min / user — discourages SMS bombing.
const otpResendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip)}:${req.body?.user_id || req.body?.pending_id || 'anon'}`,
  handler: jsonError('Too many resend requests. Try again in 10 minutes.'),
});

// Refresh: 30 / 15 min / IP — generous, but bounds runaway clients.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  handler: jsonError('Too many token refresh requests.'),
});

// Forgot password: 5 / hour / IP — prevents email bombing.
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  handler: jsonError('Too many password reset requests. Try again in an hour.'),
});

module.exports = {
  loginLimiter,
  registerLimiter,
  otpVerifyLimiter,
  otpResendLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
};
