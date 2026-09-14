-- 061 — plan feedback: the self-learning signal.
--
-- Gate 1 and Gate 2 turned the planner into something with a correction loop:
-- the user edits the storyboard before approving, and approves (or not) the
-- stills. Each of those is a label — "you proposed X, I actually wanted Y" —
-- and this table captures it so the planner can, later, learn from what worked
-- (retrieval of similar approved plans; a per-creator style memory; eventually
-- fine-tuning). Nothing here changes behaviour yet; it is the data asset the
-- learning is built on. Capture first, learn second.
--
-- One row per PLAN (a proposal). It is enriched as the plan moves:
--   plan    → proposed_plan + idea            (POST /shoots/plan)
--   approve → approved_plan + project + edited (POST /shoots/generate)
--   review  → stills_approved                  (POST /shoots/:id/approve)

CREATE TABLE IF NOT EXISTS plan_feedback (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  avatar_id       INTEGER     REFERENCES avatars(id) ON DELETE SET NULL,
  created_by      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  project_id      INTEGER     REFERENCES studio_projects(id) ON DELETE SET NULL,

  idea            TEXT,                                   -- the raw brief the creator typed/spoke
  kind            TEXT,                                   -- reel | short | post | carousel | longform
  clip_seconds    INTEGER,

  proposed_plan   JSONB,                                  -- what the planner returned
  approved_plan   JSONB,                                  -- what the user approved (their edits applied)
  edited          BOOLEAN     NOT NULL DEFAULT FALSE,     -- did approved differ from proposed?
  stills_approved BOOLEAN     NOT NULL DEFAULT FALSE,     -- passed the Gate 2 stills review

  status          TEXT        NOT NULL DEFAULT 'planned', -- planned | generated | stills_approved | discarded

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_feedback_tenant  ON plan_feedback(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_feedback_avatar  ON plan_feedback(avatar_id);
CREATE INDEX IF NOT EXISTS idx_plan_feedback_project ON plan_feedback(project_id);
-- Retrieval (step 2) will read the APPROVED, well-received plans as examples.
CREATE INDEX IF NOT EXISTS idx_plan_feedback_learn   ON plan_feedback(tenant_id, kind, stills_approved) WHERE approved_plan IS NOT NULL;
