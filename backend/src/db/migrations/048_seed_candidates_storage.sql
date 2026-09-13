-- 048_seed_candidates_storage.sql
--
-- Candidates that were generated on the server, not on somebody's laptop.
--
-- 047 assumed the frames were files in `studio/personas/<slug>/candidates`,
-- because that is where `studio/seed-set.js` writes them. That is true for the
-- person who owns the repository and a GPU, and false for every customer: they
-- have none of the three, so their pool is generated on fal by the render queue
-- and the bytes land in object storage.
--
-- Both paths stay. The local one is how R&D happens and it costs nothing; the
-- queued one is how the product works. A row knows which it is by whether it
-- has a storage key.

BEGIN;

ALTER TABLE seed_candidates
  -- Where the object lives, as the storage driver names it. NULL means the
  -- frame is a file in the persona directory — the local path.
  ADD COLUMN IF NOT EXISTS storage_key TEXT,
  -- The job that produced it. Not a foreign key: render_jobs are pruned once
  -- they are old, and a candidate must not go with them. It is a breadcrumb for
  -- "why is this frame here and what did it cost", not a relationship.
  ADD COLUMN IF NOT EXISTS job_id      INTEGER,
  -- Frames arrive one job at a time over several minutes. A batch id lets the
  -- screen say "34 of 80 so far" instead of watching a number climb with no
  -- idea what it is climbing towards.
  ADD COLUMN IF NOT EXISTS batch       TEXT;

CREATE INDEX IF NOT EXISTS idx_seed_candidates_batch
  ON seed_candidates(avatar_id, batch) WHERE batch IS NOT NULL;

COMMENT ON COLUMN seed_candidates.storage_key IS
  'Object storage key for a queue-generated frame. NULL means a local file in '
  'the persona directory, which is how studio/seed-set.js produces them.';

COMMIT;
