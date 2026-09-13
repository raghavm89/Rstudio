-- 034 — remember which app a registration started from.
--
-- A sign-up at studio.rstudio.app should end with a workspace; a sign-up at
-- rstudio.app should not, because there the tenant is created by an admin and
-- silently minting one per visitor would litter the platform with empty
-- tenants. Both flows share one `pending_registrations` row, so the row has to
-- carry which app it came from.
--
-- Why store it rather than derive it at verification time: the audience comes
-- from the request Origin, and the verify request is a SEPARATE request from
-- the register one. A person can register on Studio and land on the verify step
-- from anywhere — a link in the email, a different tab, a phone. Deriving it
-- twice means the second derivation can disagree with the first, and the
-- disagreement decides whether they get a workspace. Recording the decision at
-- the moment they actually chose the app makes it a fact rather than a guess.
--
-- Defaults to 'platform' so every row already in the table keeps today's
-- behaviour exactly.

ALTER TABLE pending_registrations
  ADD COLUMN IF NOT EXISTS signup_audience TEXT NOT NULL DEFAULT 'platform';

-- Constrain to the audiences the app knows about. A value outside this set
-- would silently fall through to "no workspace", which is the failure that is
-- hardest to notice: the person signs in successfully and simply has nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_registrations_signup_audience_allowed'
  ) THEN
    ALTER TABLE pending_registrations
      ADD CONSTRAINT pending_registrations_signup_audience_allowed
      CHECK (signup_audience IN ('platform', 'studio', 'admin'));
  END IF;
END $$;

COMMENT ON COLUMN pending_registrations.signup_audience IS
  'Which app this registration began at, captured from the Origin of the register request. Studio sign-ups are provisioned a workspace on verification; platform sign-ups are not.';
