-- 016_pending_registrations.sql
-- Stores registration data temporarily until the email OTP is verified.
-- A real users row is only inserted after successful OTP confirmation.
-- Stale rows (older than 1 hour) can be purged by a periodic job or cron.

CREATE TABLE IF NOT EXISTS pending_registrations (
  id             SERIAL       PRIMARY KEY,
  name           TEXT         NOT NULL,
  email          TEXT         NOT NULL,
  password_hash  TEXT         NOT NULL,
  phone_number   TEXT,
  address        TEXT,
  role           TEXT         NOT NULL DEFAULT 'tenant_user',
  otp_token      TEXT,
  otp_expires_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT pending_registrations_email_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_pending_reg_email
  ON pending_registrations (email);
