-- 017_pending_reg_resend_limits.sql
-- Adds resend-rate-limiting columns to pending_registrations.

ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS resend_count   INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resent_at TIMESTAMPTZ;
