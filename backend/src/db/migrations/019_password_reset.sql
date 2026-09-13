-- Migration 019: password reset tokens
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_token      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token
  ON users (password_reset_token)
  WHERE password_reset_token IS NOT NULL;
