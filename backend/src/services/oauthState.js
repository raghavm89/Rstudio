'use strict';

const crypto = require('crypto');
const pool = require('../config/db');
const { AUDIENCES, DEFAULT_AUDIENCE } = require('./audience');

/**
 * Carrying "which app" and "is this really our flow" across an OAuth round trip.
 *
 * Two problems, one mechanism.
 *
 * ── Which app ────────────────────────────────────────────────────────────────
 * Everywhere else, a token's audience comes from the request Origin, because a
 * caller that can nominate its own audience proves nothing. An OAuth callback
 * has no Origin we can use — the browser arrives by top-level redirect from
 * Google, so the Origin is Google's or absent. The `state` parameter is the only
 * thing that survives the round trip, and it is attacker-visible, so it has to
 * be signed: we mint it, so a value that verifies is a value we chose.
 *
 * ── Is this really our flow ───────────────────────────────────────────────────
 * The current flow sends no `state` at all, which is a login-CSRF hole: an
 * attacker completes an authorization with THEIR provider account and gets the
 * victim's browser to finish it, silently signing the victim into the attacker's
 * account. Everything the victim then does — connecting an Instagram account,
 * uploading a face — happens in a workspace the attacker can read. A nonce in
 * signed state closes it, and since we need signed state for the audience
 * anyway, it costs nothing extra.
 *
 * HMAC rather than a stored row: state is short-lived, self-describing, and
 * verified once. The handoff code that follows IS stored, because that one must
 * be single-use and a signature cannot express "already spent".
 */

const TTL_MS = 10 * 60 * 1000;      // A person picking an account, not a machine.
const HANDOFF_TTL_MS = 90 * 1000;   // Long enough for a redirect, short enough to be useless if leaked.

function secret() {
  // Deliberately fails loudly rather than defaulting. A signing key with a
  // fallback value is not a signing key — every deployment that forgot to set it
  // would share the same one, and anyone who read the source could mint state.
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('JWT_ACCESS_SECRET is required to sign OAuth state');
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

const OAuthState = {
  TTL_MS,
  HANDOFF_TTL_MS,

  /** Mint state for the start of a flow. `app` decides the eventual audience. */
  create(app) {
    const audience = AUDIENCES.includes(app) ? app : DEFAULT_AUDIENCE;
    const payload = b64url(JSON.stringify({
      a: audience,
      n: crypto.randomBytes(16).toString('base64url'),  // nonce — makes each state unique
      e: Date.now() + TTL_MS,
    }));
    return `${payload}.${sign(payload)}`;
  },

  /**
   * Verify state coming back from the provider.
   *
   * Returns the audience, or null for anything that does not verify. Null is
   * deliberately indistinguishable between "tampered", "expired" and "absent":
   * the caller's response to all three is the same, and reporting which one
   * would tell an attacker whether their forgery was close.
   */
  verify(state) {
    if (typeof state !== 'string' || !state.includes('.')) return null;
    const [payload, signature] = state.split('.');
    if (!payload || !signature) return null;

    const expected = sign(payload);
    // timingSafeEqual throws on a length mismatch, which is itself a signal, so
    // the lengths are compared first and in a way that does not short-circuit
    // on content.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return null; }

    if (!claims || typeof claims.e !== 'number' || claims.e < Date.now()) return null;
    if (!AUDIENCES.includes(claims.a)) return null;
    return claims.a;
  },

  // ── Handoff ────────────────────────────────────────────────────────────────

  /**
   * Mint a single-use code that stands in for a completed sign-in.
   *
   * Returned in the clear to be put in the redirect URL; only its hash is
   * stored, so a database dump cannot be replayed into someone's session.
   */
  async createHandoff({ userId, audience, provider }) {
    const code = crypto.randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO oauth_handoff_codes (code_hash, user_id, audience, provider, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sha256(code), userId, AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE,
       provider, new Date(Date.now() + HANDOFF_TTL_MS)]
    );
    return code;
  },

  /**
   * Spend a code. Returns `{ user_id, audience, provider }` or null.
   *
   * The UPDATE ... WHERE used_at IS NULL is what makes it single-use, and it is
   * one statement on purpose: a read-then-write would let two simultaneous
   * requests both see an unused code and both mint a session. Postgres settles
   * it here instead.
   */
  async redeemHandoff(code) {
    if (typeof code !== 'string' || !code) return null;
    const { rows } = await pool.query(
      `UPDATE oauth_handoff_codes
          SET used_at = NOW()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING user_id, audience, provider`,
      [sha256(code)]
    );
    return rows[0] || null;
  },

  /** Housekeeping. Expired codes are dead weight, not a security problem. */
  async purgeExpired() {
    const { rowCount } = await pool.query(
      "DELETE FROM oauth_handoff_codes WHERE expires_at < NOW() - INTERVAL '1 day'"
    );
    return rowCount;
  },
};

module.exports = OAuthState;
