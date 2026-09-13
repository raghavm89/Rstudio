-- 050_anchor_face.sql
--
-- One face, chosen once, that every later frame is generated FROM.
--
-- ── The problem this fixes ──────────────────────────────────────────────────
-- Candidate frames are made by base Flux from the identity block, with a fresh
-- random seed per frame. Text describes a TYPE of person, not a person, so each
-- frame is an independent draw from that type and the pool is a casting call
-- rather than a photo shoot. Measured on the one persona that has been through
-- this by hand: `personas/aanya-kapoor/` holds 209 candidates and 16 keepers —
-- a 7.7% hit rate. The export gate needs twelve. Twenty-four frames, which is
-- the batch floor the product ships, cannot arithmetically produce twelve.
--
-- So the draw stops being independent. A handful of anchor frames are generated
-- from the text as before; the customer picks the one that IS the avatar; and
-- every frame after that is generated with an identity-preserving endpoint
-- conditioned on that anchor. Culling becomes confirming a set instead of
-- hunting for one, and a usable pool costs tens of frames rather than hundreds
-- — which is also the only way the plan allowances can ever cover it.
--
-- ── Why this is not `reference` mode ────────────────────────────────────────
-- Migration 033 removed generating an avatar from a photograph of a real
-- person, permanently and by CHECK constraint. Nothing here weakens that. The
-- anchor is a frame WE generated from the customer's own written description,
-- depicting nobody, already sitting in their own seed_candidates table. It
-- cannot be a photograph: the column references seed_candidates, and rows get
-- there only from a render job this system queued.

BEGIN;

ALTER TABLE avatars
  -- The chosen face. NULL means anchoring has not happened — either an avatar
  -- from before this migration, or one whose anchors have not been picked from
  -- yet. Both keep working: a pool job with no anchor is exactly the old
  -- text-only path.
  --
  -- ON DELETE SET NULL rather than CASCADE: deleting one candidate frame must
  -- not delete the avatar it happened to be the anchor for. It un-anchors it,
  -- which the screen can see and act on.
  ADD COLUMN IF NOT EXISTS anchor_candidate_id BIGINT
    REFERENCES seed_candidates(id) ON DELETE SET NULL;

ALTER TABLE seed_candidates
  -- What this frame is for. 'anchor' frames are the independent draws offered
  -- as a choice; 'pool' frames are the ones generated from the chosen anchor.
  -- Both live here because both are candidates the customer may keep — the
  -- anchor is usually the best frame of the face in the whole set.
  --
  -- Defaulted to 'pool' so every existing row keeps meaning what it meant.
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'pool';

ALTER TABLE seed_candidates
  DROP CONSTRAINT IF EXISTS seed_candidates_kind_allowed;
ALTER TABLE seed_candidates
  ADD CONSTRAINT seed_candidates_kind_allowed CHECK (kind IN ('anchor', 'pool'));

-- The anchor chooser reads exactly this: every anchor frame for one avatar.
CREATE INDEX IF NOT EXISTS idx_seed_candidates_anchor
  ON seed_candidates(avatar_id) WHERE kind = 'anchor';

COMMENT ON COLUMN avatars.anchor_candidate_id IS
  'The seed candidate whose face every later frame is generated from. NULL '
  'means unanchored, which renders exactly as it did before migration 050.';
COMMENT ON COLUMN seed_candidates.kind IS
  'anchor = an independent draw offered as a choice; pool = generated from the '
  'chosen anchor.';

COMMIT;
