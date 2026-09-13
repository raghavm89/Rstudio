-- ── 031_studio_job_dependencies.sql ──────────────────────────────────────────
-- Avatar Studio: let one click enqueue the whole plan at once.
--
-- The alternative — enqueue only the first stage and have each stage's
-- completion handler enqueue the next — works, but it hides the plan. The
-- progress view can then only show what has already happened, so a user who
-- clicks Generate sees one spinner rather than nine steps with seven still to
-- come. Declaring the graph up front means the UI can render the whole chain
-- immediately, and a failure is legible as "stage 4 of 9" instead of "it
-- stopped".
--
-- `depends_on` is an array rather than a single parent because the graph fans
-- in as well as out: four stills fan out from one prompt stage, and one assemble
-- stage waits on all four.

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS depends_on INTEGER[] NOT NULL DEFAULT '{}';

-- Position in the plan, for display. A chain is not always linear, so this is
-- "which step of the recipe" rather than an execution order.
ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS step_index INTEGER,
  ADD COLUMN IF NOT EXISTS step_total INTEGER,
  ADD COLUMN IF NOT EXISTS label TEXT;

-- 'blocked' joins the status vocabulary: a job whose dependency failed
-- permanently. Distinct from 'failed' — it never ran and never will, and telling
-- the user "skipped because frame 3 failed" is more useful than nine identical
-- failures.
COMMENT ON COLUMN render_jobs.depends_on IS
  'Job ids that must reach status=done before this one may be claimed. Empty = ready immediately.';

-- The claim query filters on this; GIN makes the containment lookup cheap once
-- a busy tenant has thousands of rows.
CREATE INDEX IF NOT EXISTS idx_render_jobs_depends_on
  ON render_jobs USING GIN (depends_on);
