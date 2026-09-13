-- 047_seed_candidates.sql
--
-- The culling decisions, in the database.
--
-- ── Where they were ─────────────────────────────────────────────────────────
-- In `studio/personas/<slug>/cull-state.json`, written by a standalone HTTP
-- service on :5055 that had no authentication, no tenant scoping, and read its
-- list of avatars ONCE at startup before closing its pool — so an avatar
-- created after it started did not exist to it.
--
-- That was survivable while one person culled one avatar on one laptop. It is
-- not a shape that survives a second tenant: a JSON file on the machine that
-- happens to be running the generator cannot be scoped to anybody.
--
-- ── Why a table of its own rather than studio_assets ────────────────────────
-- `studio_assets` is the product: stills and clips that came out of a shoot,
-- with QC status and cost. A seed candidate is an input to TRAINING — it is
-- never published, never billed as output, and it carries three axes
-- (angle, framing, light) that exist only to answer "does this set cover the
-- conditions the model must hold in". Overloading one table with both would
-- mean every query about either had to say which it meant.

BEGIN;

CREATE TABLE IF NOT EXISTS seed_candidates (
  id          BIGSERIAL PRIMARY KEY,

  -- Denormalised from the avatar on purpose: every read of this table is
  -- tenant-scoped, and a join to get there is a join somebody eventually
  -- forgets. The trigger below keeps it honest.
  tenant_id   INTEGER     NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  avatar_id   INTEGER     NOT NULL REFERENCES avatars(id)  ON DELETE CASCADE,

  -- The file as the generator named it. Metadata lives in the name —
  -- `0001-medium-three-quarter-soft-1234567.png` — and is parsed out into the
  -- columns below so that coverage is a GROUP BY rather than a scan of strings.
  filename    TEXT        NOT NULL,
  idx         INTEGER,                                   -- generation order

  angle       TEXT,                                      -- front | three-quarter | profile
  framing     TEXT,                                      -- close | medium | full
  quality     TEXT,                                      -- soft | hard

  -- Text, not a number. fal returns seeds beyond MAX_SAFE_INTEGER, and a
  -- rounded float cannot reproduce its own image — the same lesson the shoot
  -- manifest learned.
  seed        TEXT,

  -- NULL means undecided, which is the state three hundred of these start in.
  -- A boolean would have made "not looked at yet" indistinguishable from
  -- "looked at and rejected", and the difference is the whole progress bar.
  verdict     TEXT        CHECK (verdict IN ('keep', 'reject')),
  decided_at  TIMESTAMPTZ,
  decided_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Re-running the registrar over a directory must update rather than
  -- duplicate; the generator may still be adding frames while someone culls.
  UNIQUE (avatar_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_seed_candidates_avatar
  ON seed_candidates(avatar_id, idx);
-- The kept set is read on every keystroke to redraw the coverage strip.
CREATE INDEX IF NOT EXISTS idx_seed_candidates_kept
  ON seed_candidates(avatar_id) WHERE verdict = 'keep';

/**
 * The tenant on a candidate must be the tenant on its avatar.
 *
 * The column is denormalised so that reads can filter without a join. That is
 * only safe if the two cannot disagree, and "the application always sets it
 * correctly" is not a guarantee — a fixture, a support script or an import
 * writes rows too. So the database sets it, from the avatar, on every write.
 */
CREATE OR REPLACE FUNCTION seed_candidate_tenant() RETURNS TRIGGER AS $$
BEGIN
  SELECT a.tenant_id INTO NEW.tenant_id FROM avatars a WHERE a.id = NEW.avatar_id;
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'seed_candidates.avatar_id % does not exist', NEW.avatar_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_candidate_tenant ON seed_candidates;
CREATE TRIGGER trg_seed_candidate_tenant
  BEFORE INSERT OR UPDATE OF avatar_id ON seed_candidates
  FOR EACH ROW EXECUTE FUNCTION seed_candidate_tenant();

COMMENT ON TABLE seed_candidates IS
  'Training-set candidates and their keep/reject verdicts. Replaces '
  'studio/personas/<slug>/cull-state.json and the unauthenticated :5055 service.';
COMMENT ON COLUMN seed_candidates.verdict IS
  'NULL = not yet looked at. Distinct from ''reject'', which is a decision.';

COMMIT;
