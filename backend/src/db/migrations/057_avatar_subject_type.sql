-- 057 — non-human character avatars: the subject_type fork.
--
-- Adds the one column the character line branches on. A `character` avatar (a
-- personified fruit, a mascot, a creature) is still mode='synthetic' — it
-- depicts nobody, needs no consent, and migration 033's CHECK already allows it.
-- What differs is downstream: identity QC measures a whole-image (CLIP)
-- embedding instead of a face one, there is no expression calibration, and the
-- look profile becomes a style profile. All of that reads this column.
--
-- See claude/character-line-scope.md (Phase A).

BEGIN;

ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'person';

-- Existing avatars are all people — the DEFAULT backfills them. The constraint
-- is added separately and idempotently so a re-run does not error.
ALTER TABLE avatars DROP CONSTRAINT IF EXISTS avatars_subject_type_allowed;
ALTER TABLE avatars
  ADD CONSTRAINT avatars_subject_type_allowed CHECK (subject_type IN ('person', 'character'));

COMMENT ON COLUMN avatars.subject_type IS
  'person | character. A character depicts nobody (always mode=synthetic) and takes the non-human pipeline: CLIP-embedding identity QC, no expression calibration, a style profile in place of the look profile.';

COMMIT;
