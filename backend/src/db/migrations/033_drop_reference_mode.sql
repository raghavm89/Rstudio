-- 033_drop_reference_mode.sql
--
-- Remove `reference` as a possible avatar mode. Permanently, and at the database
-- rather than in a comment.
--
-- WHAT IT WAS: generating an avatar from a photograph of a real person who is
-- not the account holder — "make me someone who looks like this."
--
-- WHY IT IS GONE, rather than merely unbuilt:
--
--   The legal test for a likeness is IDENTIFIABILITY, not copying. "Similar to"
--   is exactly where personality-rights cases are won, so the feature is not
--   made safe by generating rather than editing. Stock photography does not fix
--   it either: none of the major free libraries guarantees a model release, and
--   all of them prohibit compiling their images into a competing service. An
--   older photographic release does not extend to model training or digital
--   replica use — that needs an AI-specific release naming source material,
--   permitted modifications, media, territories, duration and takedown.
--
--   India's IT Rules place obligations on the TOOL, not only the person posting,
--   with a three-hour takedown window. A feature whose ordinary use produces a
--   recognisable image of someone who never agreed is a liability the product
--   does not need.
--
--   And it is not needed. When a customer says "I want a face like this," they
--   almost always mean they cannot describe a face in words and want to point at
--   one. The face catalogue answers that completely — fifty faces we generated
--   ourselves, depicting nobody. So this is a feature we can decline rather than
--   a gap we are apologising for.
--
-- WHAT REMAINS:
--   synthetic — a person who does not exist. No consent record required.
--   twin      — the ACCOUNT HOLDER'S OWN likeness. Requires a verified consent
--               record before any generation or training. Legitimate: the
--               subject is consenting to themselves.
--
-- A CHECK constraint rather than an application-level guard on purpose. The
-- application refusals already exist and are tested, but they can be bypassed by
-- a migration, a fixture, a support script or an admin tool. This cannot.

DO $$
DECLARE
  offending INTEGER;
BEGIN
  SELECT COUNT(*) INTO offending FROM avatars WHERE mode = 'reference';
  IF offending > 0 THEN
    -- Deliberately fatal. Silently rewriting someone's avatar to another mode
    -- would change what it legally is without anyone deciding to.
    RAISE EXCEPTION
      '% avatar(s) still use mode=reference. Resolve each one deliberately '
      '(retire it, or convert to twin with a verified consent record) before applying this migration.',
      offending;
  END IF;
END $$;

ALTER TABLE avatars DROP CONSTRAINT IF EXISTS avatars_mode_allowed;

ALTER TABLE avatars
  ADD CONSTRAINT avatars_mode_allowed CHECK (mode IN ('synthetic', 'twin'));

COMMENT ON COLUMN avatars.mode IS
  'synthetic (depicts nobody, no consent needed) | twin (the account holder''s own likeness, requires a verified consent record). `reference` was removed in migration 033 — see that file for why it is not coming back.';

-- The same reasoning applies to a consent record: there is no longer a mode it
-- could serve other than `twin`.
COMMENT ON TABLE consent_records IS
  'Verified consent for twin-mode avatars only. A ticked box is not a gate — it is a log entry proving you knew. Generation and training are both refused without a verified record here.';
