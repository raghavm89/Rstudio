'use strict';

const { AUDIENCES } = require('../services/audience');

/**
 * Require that a verified token was minted for THIS app.
 *
 * Runs AFTER `authenticate`, which stays untouched — the existing middleware
 * keeps working for every existing route, and this is additive. Rewriting
 * `auth.js` to demand an audience would 401 every signed-in user the moment it
 * deployed, which is a poor trade for a claim that can be added beside it.
 *
 * ── Rolling this out without locking anyone out ──────────────────────────────
 *
 * Tokens already in the wild carry no `aud`. So:
 *
 *   1. Deploy the signing change (audience on new tokens) with
 *      `ENFORCE_TOKEN_AUDIENCE` unset. Nothing changes for anyone.
 *   2. Access tokens live 15 minutes and the refresh endpoint mints new ones, so
 *      roughly twenty minutes later every live session carries an audience.
 *   3. Set `ENFORCE_TOKEN_AUDIENCE=true`. From then on a token without an
 *      audience, or with the wrong one, is refused.
 *
 * Until step 3, a missing audience is allowed through but logged, so you can
 * watch the count fall to zero before enforcing rather than guessing.
 */
function requireAudience(...allowed) {
  const expected = allowed.filter((a) => AUDIENCES.includes(a));
  if (!expected.length) {
    throw new Error(`requireAudience needs at least one of: ${AUDIENCES.join(', ')}`);
  }

  return (req, res, next) => {
    const enforcing = String(process.env.ENFORCE_TOKEN_AUDIENCE || '') === 'true';
    const aud = req.user?.aud;

    if (!aud) {
      if (enforcing) {
        return res.status(401).json({
          error: 'This session predates audience scoping — sign in again',
          code: 'TOKEN_AUDIENCE_MISSING',
        });
      }
      // Grace period. Counting these is how you know when it is safe to enforce.
      console.warn(`[audience] legacy token without aud on ${req.method} ${req.originalUrl}`);
      return next();
    }

    if (!expected.includes(aud)) {
      // A real cross-app token. Refuse whether or not enforcement is on: this is
      // the case the claim exists for, and letting it through during the grace
      // period would defeat the point of adding it.
      return res.status(403).json({
        error: `This token belongs to another application (${aud})`,
        code: 'TOKEN_AUDIENCE_MISMATCH',
      });
    }

    next();
  };
}

module.exports = requireAudience;
