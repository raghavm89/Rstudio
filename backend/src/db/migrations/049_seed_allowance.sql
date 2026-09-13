-- 049_seed_allowance.sql
--
-- Candidate frames get their own allowance, counted per avatar.
--
-- ── Why they cannot keep coming out of still_megapixels ─────────────────────
--
-- That meter is the month's SHOOTING budget: the stills a customer publishes.
-- Charging an avatar's setup to it means creating an avatar costs a month of
-- posts, and the arithmetic made that plain — a usable candidate pool is around
-- eighty frames at one megapixel each, and the entire monthly still allowance
-- is 15 on Free, 40 on Pro and 160 on Max. No plan could set up a single
-- avatar, and it is the first thing every customer has to do.
--
-- ── Why per avatar rather than per month ────────────────────────────────────
--
-- A seed set is a one-off. It is generated once, culled once, trained from
-- once, and then never again unless the identity block changes — which is
-- itself a deliberate act with a bible_version behind it. A monthly budget for
-- a one-off purchase is the wrong shape: it expires unused for everybody who is
-- not setting an avatar up this month, and it is never enough for anybody who
-- is.
--
-- Per avatar is also the number a person can hold: "every avatar comes with N
-- photos to choose from" is a sentence; "your monthly megapixel allowance minus
-- whatever you have already shot" is a calculation.
--
-- Beyond the included count, credits — at the same 2-per-megapixel rate
-- everything else is charged at, so there is one price for a generated frame
-- however it was asked for.

BEGIN;

ALTER TABLE avatars
  -- Frames counted against this avatar's included allowance. Not a count of
  -- rows in seed_candidates: a frame that failed at fal returns its allowance,
  -- and a frame deleted later does not give it back — you spent it looking.
  ADD COLUMN IF NOT EXISTS seed_frames_used INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN avatars.seed_frames_used IS
  'Candidate frames charged to this avatar''s included allowance. Incremented '
  'on reservation, decremented only when a frame fails and its reservation is '
  'returned.';

-- Backfill: any avatar whose pool was generated before this existed has already
-- spent the frames. Counting the rows is the closest true answer, and leaving
-- it at zero would hand those avatars a second free allowance.
UPDATE avatars a
   SET seed_frames_used = c.n
  FROM (SELECT avatar_id, COUNT(*)::int AS n FROM seed_candidates GROUP BY avatar_id) c
 WHERE c.avatar_id = a.id AND a.seed_frames_used = 0;

-- ── The included counts ─────────────────────────────────────────────────────
--
-- Priced from what a frame actually costs: $0.035 on fal, ~₹3.50 at ₹100/$.
--
--   Free  40  ≈ ₹140  — enough to see the face and decide, not enough to train
--                       a model that holds. 40 frames covers the 18-cell gate
--                       twice over, so the coverage strip fills and the export
--                       gate is reachable; the LoRA from it will simply be
--                       thinner than one from 120.
--   Pro  120  ≈ ₹420  — a working pool. Three avatars = ₹1,260 against ₹2,000,
--                       but only in a month where all three are created.
--   Max  200  ≈ ₹700  — the full range the docs describe.
--
-- Free is the number that decides whether this is affordable, because free
-- signups mostly do not convert and every one of them costs this much. 40 is
-- the smallest number that still lets somebody reach an exportable set.
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT NULL, 'seed_frames', 40, 'lifetime',
       'candidate photos per avatar, enough to see the face'
 WHERE NOT EXISTS (
   SELECT 1 FROM studio_entitlements
    WHERE plan_id IS NULL AND metric = 'seed_frames' AND period = 'lifetime');

INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT p.id, v.metric, v.limit_value, v.period, v.notes
  FROM (VALUES
      ('pro', 'seed_frames', 120, 'lifetime', 'candidate photos per avatar'),
      ('max', 'seed_frames', 200, 'lifetime', 'candidate photos per avatar')
    ) AS v(slug, metric, limit_value, period, notes)
  JOIN plans p ON p.slug = v.slug
 WHERE NOT EXISTS (
   SELECT 1 FROM studio_entitlements e
    WHERE e.plan_id = p.id AND e.metric = 'seed_frames' AND e.period = 'lifetime');

COMMIT;
