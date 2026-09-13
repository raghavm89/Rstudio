'use strict';

const { parsePhoneNumber } = require('libphonenumber-js');

/**
 * Phone parsing, in one place.
 *
 * This lived in authController, which was fine while the controller was the only
 * thing that needed it. The login rate limiter needs it too — its bucket key has
 * to be the NORMALISED number, or "9876543210", "+91 98765 43210" and
 * "098765 43210" are three separate buckets for one account and the five-attempt
 * limit is really fifteen to anyone who varies the spacing.
 *
 * A limit an attacker can multiply by reformatting their input is not a limit,
 * and middleware reaching into a controller for a helper is how you end up with
 * two copies that drift.
 */

/**
 * The country assumed when someone types a bare national number.
 *
 * A fallback, never an override — the plain parse runs first, so an explicit
 * "+1 415 555 0100" is still parsed as US. This only decides what a number with
 * no country code means, which is the one case with no other answer.
 */
const DEFAULT_PHONE_COUNTRY = (process.env.DEFAULT_PHONE_COUNTRY || 'IN').toUpperCase();

/**
 * Normalise anything a person might type into E.164, or null.
 *
 * `parsePhoneNumber` with no default country THROWS on a bare national number,
 * so "9876543210" — how essentially every Indian user writes their own number —
 * was rejected outright, and only "+91 9876543210" worked. The country code is
 * exactly the part people leave off, because it is the part they never say out
 * loud.
 */
function toE164(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const raw = rawPhone.trim();
  if (!raw) return null;

  for (const country of [undefined, DEFAULT_PHONE_COUNTRY]) {
    try {
      const parsed = country ? parsePhoneNumber(raw, country) : parsePhoneNumber(raw);
      if (parsed && parsed.isValid()) return parsed.format('E.164');
    } catch {
      // Not parseable that way; fall through to the country-defaulted attempt.
    }
  }
  return null;
}

/**
 * Does this read as an email address or a phone number?
 *
 * An '@' is the only reliable separator: every email has one and no phone number
 * does. Deliberately not a validity check — that is the parser's job — only a
 * decision about which parser to hand it to, so a mistyped email gets an email
 * error rather than "that is not a valid phone number".
 */
function looksLikeEmail(identifier) {
  return typeof identifier === 'string' && identifier.includes('@');
}

/**
 * One stable key for whatever the person typed in the sign-in box.
 *
 * Used for rate-limit bucketing, so it must collapse every spelling of one
 * identity onto one string. An unparseable value falls back to its trimmed,
 * lower-cased self rather than to '' — everything unparseable sharing a single
 * bucket is its own lockout.
 */
function identityKey(raw) {
  const typed = String(raw ?? '').trim().toLowerCase();
  if (!typed) return '';
  if (looksLikeEmail(typed)) return typed;
  return toE164(typed) || typed;
}

module.exports = { toE164, looksLikeEmail, identityKey, DEFAULT_PHONE_COUNTRY };
