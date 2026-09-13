-- 037_password_column.sql
--
-- One name for the password hash: `password_hash`.
--
-- ── What actually went wrong ────────────────────────────────────────────────
-- 001 created `users.password`. No migration ever renamed it, but the live
-- database has `password_hash` — so the schema was changed by hand at some point
-- and the ledger never heard about it. The code then drifted to match, one site
-- at a time, and ended up split:
--
--   users.js        INSERT ... (password)          ← the only writer still on the old name
--   oauth.js        INSERT ... (password_hash)
--   userController  SELECT password  … UPDATE password_hash   ← both, in one function
--   authController  reads user.password, writes password_hash
--
-- Against the live schema every one of those `password` references fails. Local
-- sign-up died on the INSERT, which is how this surfaced. Sign-in failed more
-- quietly and more seriously: it reads `user.password`, found undefined, decided
-- the account had no local password, and told people their account was created
-- with Google — confidently, and wrongly, to everyone with a password.
--
-- ── Why a migration and not just a code fix ─────────────────────────────────
-- Fixing only the code would repair the live database and break every fresh one:
-- a database built from 001 onwards has `password`, and code that expects
-- `password_hash` fails there instead. The two have to be brought back into
-- agreement, or the next person to run `npm run db:migrate` on an empty database
-- gets the same bug with the sign reversed.
--
-- Written to be safe in all three states — only `password`, only
-- `password_hash`, or both — because which one a given environment is in is
-- exactly what nobody can currently say for certain.

BEGIN;

DO $$
DECLARE
  has_old BOOLEAN;
  has_new BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'users' AND column_name = 'password')      INTO has_old;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'users' AND column_name = 'password_hash') INTO has_new;

  IF has_old AND NOT has_new THEN
    -- The state a database built from the migrations is in.
    RAISE NOTICE 'renaming users.password -> users.password_hash';
    ALTER TABLE users RENAME COLUMN password TO password_hash;

  ELSIF has_old AND has_new THEN
    -- Both present: somebody added the new column without moving the data.
    -- Carry over any hash that exists only under the old name, then drop it.
    -- COALESCE keeps password_hash where it is already set — the newer column is
    -- the one the password-reset and change-password paths have been writing to,
    -- so it is the more recent truth for any row where they disagree.
    RAISE NOTICE 'both columns present — merging users.password into users.password_hash';
    UPDATE users
       SET password_hash = COALESCE(NULLIF(password_hash, ''), password)
     WHERE password IS NOT NULL AND password <> '';
    ALTER TABLE users DROP COLUMN password;

  ELSIF has_new THEN
    RAISE NOTICE 'users.password_hash already the only password column — nothing to do';

  ELSE
    -- Neither. Not recoverable by guessing, and creating an empty column would
    -- hand every account a NULL hash and lock everyone out silently.
    RAISE EXCEPTION 'users has neither `password` nor `password_hash` — refusing to guess';
  END IF;
END $$;

-- Nullable on purpose: an OAuth account has no local password, and this column
-- being NOT NULL is what would force a placeholder hash into rows that should
-- simply have none.
COMMENT ON COLUMN users.password_hash IS
  'bcrypt hash of the local password. NULL for accounts created through OAuth, '
  'which is what authController checks before reporting "this account has no password".';

COMMIT;
