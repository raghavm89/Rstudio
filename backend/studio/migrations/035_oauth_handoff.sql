-- 035 — one-time handoff codes for OAuth returns.
--
-- The existing OAuth flow finishes by redirecting to
-- `/auth/callback?token=<jwt>&user=<json>`. That puts a live bearer token in a
-- URL, which means it lands in browser history, in the Referer header of the
-- next request the page makes, and in the access log of anything in front of the
-- app. It is also why that flow cannot set the refresh cookie usefully in
-- development: the cookie is set on the BACKEND's origin during the redirect,
-- and the frontend on another port never sees it.
--
-- A handoff code fixes both. The redirect carries an opaque single-use string
-- that is worthless on its own; the frontend POSTs it back same-origin, and THAT
-- response carries the access token in a body and sets the refresh cookie on the
-- origin the person is actually on. A leaked URL yields a code that is expired
-- within a minute and already spent.
--
-- Stored as a SHA-256 hash, the same way refresh tokens are: a database dump
-- should not contain anything that can be replayed.

CREATE TABLE IF NOT EXISTS oauth_handoff_codes (
  id          SERIAL      PRIMARY KEY,
  code_hash   TEXT        NOT NULL UNIQUE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which app the person clicked "sign in" from, carried through the provider
  -- round trip so the token minted at redemption gets the right audience. It
  -- comes from state we signed, never from the query string.
  audience    TEXT        NOT NULL DEFAULT 'platform'
              CHECK (audience IN ('platform', 'studio', 'admin')),
  provider    TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Set on redemption rather than deleting the row, so a replayed code is
  -- distinguishable from an expired one and a second attempt can be logged
  -- rather than silently treated as a typo.
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_handoff_expiry ON oauth_handoff_codes(expires_at);

COMMENT ON TABLE oauth_handoff_codes IS
  'Single-use, short-lived codes that carry an OAuth sign-in from the provider redirect to a same-origin POST. Rows are safe to delete once expired.';
