-- 038_pending_phone_unique.sql
--
-- One in-flight sign-up per phone number.
--
-- `pending_registrations` was UNIQUE on email only, so two people could hold
-- pending rows for the same number at once. Both were sent an SMS, both typed
-- codes, and the second one to finish hit "Phone number already registered" at
-- the very last step — after we had paid for a message and after they had done
-- all the work. `users.phone_number` is UNIQUE, so the data was never wrong; the
-- cost was money and the worst possible moment to fail.
--
-- With this, the collision surfaces at `POST /register`, where the honest answer
-- is available and nothing has been spent yet.
--
-- ── Why the duplicates are deleted rather than merged ───────────────────────
-- A pending registration is ephemeral by design (016: "stale rows older than 1
-- hour can be purged") and contains nothing that is not re-enterable — it is a
-- form someone is halfway through. Keeping the newest row per number and
-- dropping the rest costs whoever is affected one restart of a flow they had not
-- finished, which is what a conflicting sign-up costs anyway.

BEGIN;

-- Keep the most recent attempt per number; drop the rest.
DELETE FROM pending_registrations a
 USING pending_registrations b
 WHERE a.phone_number = b.phone_number
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_registrations_phone_unique'
  ) THEN
    ALTER TABLE pending_registrations
      ADD CONSTRAINT pending_registrations_phone_unique UNIQUE (phone_number);
  END IF;
END $$;

COMMENT ON CONSTRAINT pending_registrations_phone_unique ON pending_registrations IS
  'One in-flight sign-up per number, so a collision is reported at /register '
  'rather than after both people have been sent an SMS and typed their codes.';

COMMIT;
