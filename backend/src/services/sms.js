const twilio = require('twilio');

/**
 * Who the message is from, and where it can autofill.
 *
 * An unbranded "Your verification code is: 838283" is indistinguishable from
 * every spam and phishing SMS a person gets. They cannot tell which of the three
 * signups they started it belongs to, and the safest reading of an unattributed
 * code is to ignore it.
 */
const BRAND = process.env.SMS_BRAND || 'Rstudio Studio';

/**
 * The origin-bound one-time-code line, which browsers and both mobile platforms
 * read to offer the code as a one-tap autofill (WebOTP). It only fires when the
 * domain here matches the origin of the page waiting for the code, so it is
 * configurable rather than hard-coded — and omitted entirely when unset, because
 * a wrong domain on that line is worse than no line: it silently never fills.
 */
const OTP_DOMAIN = (() => {
  // APP_URL in this project is often set WITHOUT a scheme ("rstudio.app") —
  // routes/oauth.js carries the same note and its own workaround. `new URL()`
  // throws on that, and a bare try/catch would have silently dropped the
  // autofill line on the one environment that matters most.
  const raw = process.env.SMS_OTP_DOMAIN || process.env.APP_URL || '';
  const host = String(raw).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  // A hostname, not "localhost" and not an empty string: WebOTP needs a real
  // registrable domain, and a line reading "@localhost #838283" is noise in
  // every message sent from a developer's machine.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
})();

/**
 * The one place the OTP message is written.
 *
 * It was inline in both send paths, which is two copies of a string that must be
 * identical — and in India it must be identical to something else too. See the
 * DLT note below.
 *
 * Fits in a single GSM-7 segment (122 characters with the autofill line, against
 * a 160 limit), so the brand and the autofill cost nothing per message. Check
 * that again before adding to it: crossing 160 doubles the bill on every code
 * this product ever sends.
 *
 * ── India / TRAI DLT ────────────────────────────────────────────────────────
 * Transactional SMS to Indian numbers must match a template pre-registered on
 * the operator DLT portal, variable-for-variable, or the carrier drops it — the
 * send still returns success from Twilio and the message simply never arrives.
 * If you change a word here, change the registered template too. Register it as:
 *
 *   {#var#} is your Rstudio Studio verification code. Valid for 10 minutes.
 *   Never share this code.
 */
function otpBody(code) {
  const lines = [`${code} is your ${BRAND} verification code. Valid for 10 minutes. Never share this code.`];
  if (OTP_DOMAIN) lines.push('', `@${OTP_DOMAIN} #${code}`);
  return lines.join('\n');
}

function isConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
}

/**
 * Send an SMS OTP. Best-effort.
 *
 * Returns instead of throwing when Twilio is unconfigured, because the callers
 * that use this — resend-otp on an existing account, the login second factor —
 * are places where a missing SMS is an inconvenience and the person has another
 * way in.
 *
 * Do NOT use this for sign-up. See `sendOtpOrFail` below for why.
 */
async function sendOtp(toPhone, code) {
  if (!isConfigured()) {
    console.warn(`[warn] Twilio not configured — skipping SMS OTP for ${toPhone}. Code: ${code}`);
    return { sent: false, reason: 'not_configured' };
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: otpBody(code),
    from: process.env.TWILIO_PHONE_NUMBER,
    to: toPhone,
  });
  return { sent: true };
}

/**
 * Send an SMS OTP, and fail the request if it did not go.
 *
 * Sign-up is the one place where "the SMS quietly did not send" is unsurvivable.
 * The person is sitting on a screen asking for a code, the code exists only in a
 * server log, and there is no way forward: they cannot receive it, cannot skip
 * it, and re-registering hits "email already registered". They conclude the
 * product is broken, and they are right.
 *
 * `sendOtp` is best-effort by design and returns cleanly when Twilio is missing.
 * That behaviour is correct for a resend on an existing account and catastrophic
 * for the only route into the product, so sign-up gets its own door rather than
 * a flag on the shared one — a boolean parameter would eventually be passed the
 * wrong way by someone who had not read this comment.
 *
 * Throws with `err.code = 'SMS_UNAVAILABLE'` so the controller can answer 503
 * ("try again in a moment") rather than 400 ("you did something wrong"). It is
 * our outage, and the status code should say so.
 */
async function sendOtpOrFail(toPhone, code) {
  if (!isConfigured()) {
    const err = new Error(
      'SMS is not configured on this server, so a verification code cannot be sent. '
      + 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.'
    );
    err.code = 'SMS_UNAVAILABLE';
    throw err;
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  try {
    const msg = await client.messages.create({
      body: otpBody(code),
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toPhone,
    });
    return { sent: true, sid: msg.sid };
  } catch (cause) {
    // Twilio's own errors are specific and worth keeping — 21211 is "that is not
    // a real number", which is the person's problem and fixable by them; almost
    // everything else is ours. Losing the distinction here means every SMS
    // failure looks the same in the logs at the moment you most need it not to.
    const err = new Error(`SMS could not be sent: ${cause.message}`);
    err.code = cause.code === 21211 || cause.code === 21614 ? 'SMS_BAD_NUMBER' : 'SMS_UNAVAILABLE';
    err.twilioCode = cause.code;
    throw err;
  }
}

module.exports = { sendOtp, sendOtpOrFail, isConfigured, otpBody };
