-- 056 — the per-piece credit wallet.
--
-- 055 set the prices and tiers and left content quotas as INTERIM per-unit
-- translations (video_seconds, still_megapixels). This migration lands the
-- settled model: one credit wallet per plan, spent per PIECE at the rate card
-- (a whole video = 6 credits regardless of its seconds; a still = 1). See
-- claude/credit-denomination-settled.md.
--
-- The wallet is a new `credits` metric on studio_entitlements, enforced by the
-- same reserve/settle machinery as every other metric (StudioUsage). The code
-- now meters `credits` for content (orchestrator + jobResult); the interim
-- per-unit quotas from 055 are left in place but no longer enforced for content
-- — a counter nobody reserves against reads as a limit and is not, so they are
-- removed here to avoid two numbers claiming to cap the same thing.

BEGIN;

-- ── The wallet: monthly credits per plan (the bundle at the rate card) ──────
-- Free 40 · Catalogue 150 · Pro 220 · Max 750 · Ultra 1,850. A credit ≈ ₹4.50
-- of supplier cost, so spending the whole wallet reproduces the frozen margins.
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT p.id, 'credits', v.credits, 'month', v.notes
  FROM plans p JOIN (VALUES
    ('catalogue', 150,  '~20 videos + 30 stills'),
    ('pro',       220,  '~30 videos + 40 stills'),
    ('max',       750,  '~100 videos + 150 stills'),
    ('ultra',    1850,  '~250 videos + 350 stills')
  ) AS v(slug, credits, notes) ON v.slug = p.slug
ON CONFLICT (plan_id, metric, period) DO UPDATE
  SET limit_value = EXCLUDED.limit_value, notes = EXCLUDED.notes;

-- Free (plan_id IS NULL): 40 credits. NULLs are distinct in the unique index,
-- so ON CONFLICT would not match — replace explicitly, as 055 does for avatars.
DELETE FROM studio_entitlements WHERE plan_id IS NULL AND metric = 'credits' AND period = 'month';
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
VALUES (NULL, 'credits', 40, 'month', '~5 videos + 10 stills');

-- ── Retire the interim per-unit content quotas ──────────────────────────────
-- 055 set these so the tiers worked before the wallet existed. Content is now
-- metered in credits; leaving these would be a second cap on the same spend.
-- (avatars, realtime_minutes, publishes, faces_claimed are untouched — they are
-- not content spend and are still enforced on their own metrics.)
DELETE FROM studio_entitlements
 WHERE metric IN ('video_seconds', 'still_megapixels') AND period = 'month';

-- ── Top-up in the new anchor: ₹500 → 77 credits (~₹6.50/credit) ─────────────
-- A margin over the ~₹4.50 cost. 044 set this to 210 at the old ~₹2.35/credit
-- anchor; the wallet re-anchors a credit, so the pack re-anchors with it.
UPDATE credit_packs SET credits = 77 WHERE slug = 'topup-500';

COMMIT;
