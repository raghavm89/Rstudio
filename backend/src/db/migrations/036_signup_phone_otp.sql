-- 036_signup_phone_otp.sql
--
-- Phone becomes mandatory at sign-up, and verified by SMS before the account
-- exists.
--
-- Sign-up used to be one hop: email code in, user row out. It is now two, and a
-- pending registration therefore has to remember that the first hop is done —
-- otherwise a replayed email code would re-send an SMS on every submission, and
-- each of those costs money.
--
-- ── What is deliberately NOT changed ────────────────────────────────────────
-- `users.phone_number` stays nullable. Accounts already exist that were created
-- while phone was optional; making the column NOT NULL would make every one of
-- them unloadable, and "new sign-ups must give a phone" is a statement about the
-- sign-up form, not about history. The requirement is enforced where the
-- requirement lives — the validator, the controller and this table.

BEGIN;

-- ── 1. Stale pending rows without a phone ───────────────────────────────────
--
-- These are registrations abandoned mid-flow under the old rules. The table is
-- explicitly ephemeral (016: "stale rows older than 1 hour can be purged"), and
-- there is no way to complete one now — the new flow needs a number to send a
-- code to, and there is none. Deleting them is what makes the NOT NULL below
-- honest rather than a constraint that fails on contact with real data.
DELETE FROM pending_registrations
 WHERE phone_number IS NULL OR btrim(phone_number) = '';

ALTER TABLE pending_registrations
  ALTER COLUMN phone_number SET NOT NULL;

-- ── 2. The second hop ───────────────────────────────────────────────────────
ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS email_verified_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_otp             TEXT,
  ADD COLUMN IF NOT EXISTS phone_otp_expires_at  TIMESTAMPTZ,
  -- Wrong guesses, not resends. Six digits is a million combinations, but a
  -- script does not need to be clever if nothing counts its attempts.
  ADD COLUMN IF NOT EXISTS phone_attempts        INT NOT NULL DEFAULT 0,
  -- Resends, counted separately from the email ones. Sharing `resend_count`
  -- between the two would let five email resends exhaust the phone budget of a
  -- person who has not reached the phone step yet.
  ADD COLUMN IF NOT EXISTS phone_resend_count    INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN pending_registrations.email_verified_at IS
  'Set when the emailed code is accepted. Its presence is what allows the phone '
  'step to run, and its absence is what stops a replayed email code from sending '
  'another SMS.';

COMMENT ON COLUMN pending_registrations.phone_attempts IS
  'Wrong SMS codes submitted. Capped in the controller; the row is dead once the '
  'cap is reached and the person registers again.';

-- ── 3. Finding a row by phone during sign-up ────────────────────────────────
-- The conflict re-check reads pending rows by number. Without this it is a
-- sequential scan on every sign-up, which is fine at ten users and not at ten
-- thousand.
CREATE INDEX IF NOT EXISTS idx_pending_reg_phone
  ON pending_registrations (phone_number);

COMMIT;
