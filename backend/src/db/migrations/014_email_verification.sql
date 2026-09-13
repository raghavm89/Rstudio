-- Migration 014: email verification
-- Adds email_verified flag to users + a token table for the verification link.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- All existing accounts are considered verified (they pre-date this feature).
UPDATE users SET email_verified = TRUE;

-- One token per user; reissuing a token simply upserts on user_id.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         SERIAL      PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(80) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_evt_token ON email_verification_tokens(token);
