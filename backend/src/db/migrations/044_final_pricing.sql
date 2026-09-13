-- 044_final_pricing.sql
--
-- The pricing that actually works: every SKU above cost, including the top-up.
--
--   Free           130 credits   ( 100s video +  15 MP)   ~₹223 per active account
--   Pro   ₹2,000   850 credits   ( 770s video +  40 MP)   +8.3%
--   Max   ₹6,000 2,600 credits   (2280s video + 160 MP)   +7.1%
--   Top-up ₹500   210 credits                             +7.6%
--
-- Worst case throughout: every credit spent on generative video at $0.022/s,
-- ₹100 to the dollar. A lipsync-heavy month costs about a fifth of that, so
-- these are floors rather than expectations.
--
-- ── The top-up is finally above cost ────────────────────────────────────────
-- At ₹500 for 300 it sold credits at ₹1.67 against a ₹2.20 marginal cost, losing
-- roughly ₹160 a pack — to heavy users, who are the only people who buy top-ups.
-- At 210 it is ₹2.38, which clears cost and sits above both plan rates, so
-- topping up repeatedly is now more expensive than moving to the next plan.
-- That is the right way round.
--
-- ── One thing the free tier gave up ─────────────────────────────────────────
-- 100 seconds no longer leaves room to re-roll a 30-second video: three of those
-- is 90s and the remaining 10s buys nothing. The notes below therefore say
-- 25 seconds, where three videos plus one re-roll is exactly 100s and the
-- doc's re-roll budget survives.
--
-- If 30-second free videos matter more than the re-roll, the honest copy is
-- "3 videos up to 30 seconds" with no headroom — and the first person to waste a
-- generation loses a third of their month. Recorded here because it is a real
-- trade and not visible from the number alone.
--
-- ── Sensitivity ─────────────────────────────────────────────────────────────
--     ₹95/$    Pro +12.9%   Max +11.7%
--    ₹100/$    Pro  +8.3%   Max  +7.1%
--    ₹105/$    Pro  +3.7%   Max  +2.4%
--
-- Unlike every earlier revision, nothing here goes negative inside a plausible
-- range for the rupee. That is the difference this one makes.

BEGIN;

-- ── Free ────────────────────────────────────────────────────────────────────
UPDATE studio_entitlements SET
  limit_value = 100,
  notes = '3 videos up to 25s, plus one re-roll of headroom'
 WHERE plan_id IS NULL AND metric = 'video_seconds' AND period = 'month';

UPDATE studio_entitlements SET
  limit_value = 15,
  notes = '15 stills at 1 MP, one candidate, watermarked'
 WHERE plan_id IS NULL AND metric = 'still_megapixels' AND period = 'month';

-- ── Pro and Max ─────────────────────────────────────────────────────────────
-- Splits keep stills at roughly a tenth of Pro's credits and an eighth of Max's,
-- rather than loading the cheaper modality to inflate the headline number.
UPDATE studio_entitlements e SET limit_value = v.limit_value, notes = v.notes
  FROM (VALUES
      ('pro', 'video_seconds',     770, 'month',    'about 13 minutes of generated video'),
      ('pro', 'still_megapixels',   40, 'month',    'full resolution, four candidates'),
      ('max', 'video_seconds',    2280, 'month',    'about 38 minutes of generated video'),
      ('max', 'still_megapixels',  160, 'month',    'full resolution, four candidates')
    ) AS v(slug, metric, limit_value, period, notes)
  JOIN plans p ON p.slug = v.slug
 WHERE e.plan_id = p.id AND e.metric = v.metric AND e.period = v.period;

-- ── Top-up ──────────────────────────────────────────────────────────────────
UPDATE credit_packs SET credits = 210 WHERE slug = 'topup-500';

COMMIT;
