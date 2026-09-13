const { Router } = require('express');
const { body } = require('express-validator');
const authenticate = require('../middleware/auth');
const {
  loginLimiter,
  registerLimiter,
  otpVerifyLimiter,
  otpResendLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
} = require('../middleware/rateLimit');
const {
  register,
  oauthExchange,
  verifyEmail,
  resendVerification,
  verifyPhone,
  resendOtp,
  login,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
  verifyPhoneSignup,
  resendPhoneSignup,
} = require('../controllers/authController');

const router = Router();

router.post(
  '/register',
  registerLimiter,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 })
      // 8 everywhere. It was 6 here and on /register while the sign-up form's
      // own hint said 8 and change-password enforced 8 — so the two
      // UNAUTHENTICATED paths were the lax ones, which is backwards: reset is
      // the door someone walks through with a stolen inbox. Raising a minimum
      // cannot lock out an existing account; it only applies to new input.
      .withMessage('Password must be at least 8 characters'),
    // Required now, and verified by SMS before the account exists. The length
    // bound is deliberately loose — E.164 allows 8 to 15 digits plus punctuation
    // people actually type — because the real check is libphonenumber in the
    // controller, and a regex here that disagrees with it would reject valid
    // numbers with a worse error message.
    body('phone_number').trim().notEmpty().withMessage('A mobile number is required')
      .isLength({ min: 8, max: 24 }).withMessage('That does not look like a mobile number'),
    body('address').optional().trim(),
  ],
  register
);

// OTP-based email verification — pending_id + 6-digit code entered by the user
router.post(
  '/verify-email',
  otpVerifyLimiter,
  [
    body('pending_id').isInt({ gt: 0 }).withMessage('Valid pending_id is required'),
    body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
  ],
  verifyEmail
);

// Resend the verification OTP
router.post(
  '/resend-verification',
  otpResendLimiter,
  [body('pending_id').isInt({ gt: 0 }).withMessage('Valid pending_id is required')],
  resendVerification
);

// Second hop of sign-up: the SMS code. Distinct from /verify-phone below, which
// verifies a number on an account that already exists — this one is what makes
// the account exist at all.
router.post(
  '/verify-phone-signup',
  otpVerifyLimiter,
  [
    body('pending_id').isInt({ gt: 0 }).withMessage('Valid pending_id is required'),
    body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
  ],
  verifyPhoneSignup
);

// Resend the sign-up SMS. On the resend limiter, because each call costs a
// message and the limiter is the only thing between that and a bill.
router.post(
  '/resend-phone-signup',
  otpResendLimiter,
  [body('pending_id').isInt({ gt: 0 }).withMessage('Valid pending_id is required')],
  resendPhoneSignup
);

router.post(
  '/verify-phone',
  otpVerifyLimiter,
  [
    body('user_id').isInt({ gt: 0 }).withMessage('Valid user_id is required'),
    body('code').isLength({ min: 6, max: 6 }).withMessage('Code must be 6 digits'),
  ],
  verifyPhone
);

router.post(
  '/resend-otp',
  otpResendLimiter,
  [body('user_id').isInt({ gt: 0 }).withMessage('Valid user_id is required')],
  resendOtp
);

router.post(
  '/login',
  loginLimiter,
  [
    // Sign-in takes an email OR a mobile number, so neither field can be
    // required on its own and `isEmail()` cannot be the gate — it would reject
    // every phone sign-in before the controller ever saw it. Which one it is,
    // and whether it parses, is decided in the controller where both parsers
    // live; this only insists that something was typed.
    body('identifier').optional().trim(),
    body('email').optional().trim(),
    body().custom((body) => {
      const typed = String(body.identifier ?? body.email ?? '').trim();
      if (!typed) throw new Error('Enter your email address or mobile number');
      return true;
    }),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  login
);

// Trades a single-use OAuth handoff code for a session. Rate-limited with the
// login limiter rather than left open: the code is unguessable, but an endpoint
// that mints sessions should not be the one place without a brake.
router.post('/oauth/exchange', loginLimiter, oauthExchange);

// Refresh token is read from the HttpOnly cookie automatically
router.post('/refresh', refreshLimiter, refresh);

// Logout routes require a valid access token
router.post('/logout',     authenticate, logout);
router.post('/logout-all', authenticate, logoutAll);

// Password reset
router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  [body('email').isEmail().withMessage('Valid email is required')],
  forgotPassword
);

router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 8 })
      // 8 everywhere. It was 6 here and on /register while the sign-up form's
      // own hint said 8 and change-password enforced 8 — so the two
      // UNAUTHENTICATED paths were the lax ones, which is backwards: reset is
      // the door someone walks through with a stolen inbox. Raising a minimum
      // cannot lock out an existing account; it only applies to new input.
      .withMessage('Password must be at least 8 characters'),
  ],
  resetPassword
);

module.exports = router;
