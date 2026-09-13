-- Migration 015: switch email verification from link-token to 6-digit OTP
-- The global UNIQUE on token must be dropped because short OTPs can collide across users.
-- We look up by (user_id, token) together — the UNIQUE(user_id) constraint already
-- ensures at most one pending OTP per user.

ALTER TABLE email_verification_tokens
  DROP CONSTRAINT IF EXISTS email_verification_tokens_token_key;

DROP INDEX IF EXISTS idx_evt_token;

-- Add a composite index for the (user_id, token) lookup used during verification
CREATE INDEX IF NOT EXISTS idx_evt_user_token ON email_verification_tokens(user_id, token);
