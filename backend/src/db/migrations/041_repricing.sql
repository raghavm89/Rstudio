-- 041_repricing.sql
--
-- Free tier halved; Pro and Max repriced; a top-up pack added.
--
-- ── Free: 120 seconds and 20 megapixels ─────────────────────────────────────
-- Was 240s + 60MP, which costs roughly ₹544 per active free account per month.
-- This is ~₹241. The seconds are framed as three 30-second videos plus one
-- re-roll rather than two 60-second ones: the pricing doc budgets a re-roll on
-- purpose, and at 2×60s a single wasted re-roll leaves someone with one finished
-- video and an empty meter — a poor showing from a tier whose only job is to
-- prove the product works.
--
-- ── Pro and Max ─────────────────────────────────────────────────────────────
-- ₹2,000 / 1,200 credits and ₹6,000 / 4,000 credits.
--
-- Recorded plainly, because it is not visible from the numbers themselves:
-- these are margin-positive at ordinary utilisation and margin-NEGATIVE if a
-- customer spends the whole allowance on generative video.
--
--     generative video costs ~₹1.94 per credit (fal, $0.022/s at ~₹88)
--     Pro sells credits at ₹1.67 · Max at ₹1.50
--
--   utilisation   Pro     Max      (all-generative mix)
--         40%     +54%    +48%
--         60%     +30%    +23%
--         80%      +7%     -3%
--        100%     -16%    -29%
--
-- That is a deliberate, survivable bet — most subscribers never spend their
-- allowance, and talking-head lipsync (₹1.50/credit) is the expected majority of
-- the mix. It is written down so that whoever watches the first month's numbers
-- knows which lever moved if the margin does: it is utilisation, and the metric
-- to instrument is credits spent per paying account.

BEGIN;

-- ── Free ────────────────────────────────────────────────────────────────────
UPDATE studio_entitlements SET
  limit_value = 120,
  notes = '3 videos up to 30s, plus one re-roll of headroom'
 WHERE plan_id IS NULL AND metric = 'video_seconds' AND period = 'month';

UPDATE studio_entitlements SET
  limit_value = 20,
  notes = '20 stills at 1 MP, one candidate, watermarked'
 WHERE plan_id IS NULL AND metric = 'still_megapixels' AND period = 'month';

-- ── Pro and Max ─────────────────────────────────────────────────────────────
-- Amounts in paise. Credits are DERIVED from these two metrics at 1 credit per
-- video second and 2 per megapixel, so the splits below are chosen to land on
-- the intended totals exactly: Pro 1000 + 100×2 = 1,200 · Max 3400 + 300×2 = 4,000.
UPDATE plans SET amount = 200000 WHERE slug = 'pro';
UPDATE plans SET amount = 600000 WHERE slug = 'max';

UPDATE studio_entitlements e SET limit_value = v.limit_value, notes = v.notes
  FROM (VALUES
      ('pro', 'video_seconds',    1000, 'month',    'about 16 minutes of generated video'),
      ('pro', 'still_megapixels',  100, 'month',    'full resolution, four candidates'),
      ('max', 'video_seconds',    3400, 'month',    'about 56 minutes of generated video'),
      ('max', 'still_megapixels',  300, 'month',    'full resolution, four candidates')
    ) AS v(slug, metric, limit_value, period, notes)
  JOIN plans p ON p.slug = v.slug
 WHERE e.plan_id = p.id AND e.metric = v.metric AND e.period = v.period;

-- ── Top-ups ─────────────────────────────────────────────────────────────────
--
-- Credits bought outright when a plan's allowance runs out.
--
-- The pack is a PRODUCT here, not a balance. Spending purchased credits needs a
-- ledger — plan credits are derived from the monthly counters and reset, while
-- bought credits are a stored balance that carries over, and the two are
-- consumed in a specific order. That is a real piece of accounting and it is not
-- built. Selling it before it can be spent would be the worst possible half:
-- money taken for credits nothing knows how to deduct.
--
-- ⚠ The rate is worth revisiting before checkout is wired. At ₹500 for 300
-- credits a top-up sells at ₹1.67 — the same rate as Pro, cheaper than Max, and
-- BELOW the ~₹1.94 that generative video costs. Top-ups are what heavy users
-- buy, so this is the one SKU priced for the customers most likely to lose money
-- on it. ₹500 for 250 credits (₹2.00) would sit above cost and give Pro users a
-- reason to move to Max instead of topping up forever.
CREATE TABLE IF NOT EXISTS credit_packs (
  id          SERIAL PRIMARY KEY,
  slug        TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  credits     INTEGER     NOT NULL CHECK (credits > 0),
  amount      INTEGER     NOT NULL CHECK (amount > 0),   -- minor units (paise)
  currency    VARCHAR(3)  NOT NULL DEFAULT 'INR',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO credit_packs (slug, name, credits, amount, currency, sort_order)
VALUES ('topup-500', 'Top-up', 300, 50000, 'INR', 1)
ON CONFLICT (slug) DO UPDATE
  SET credits = EXCLUDED.credits, amount = EXCLUDED.amount, name = EXCLUDED.name;

COMMENT ON TABLE credit_packs IS
  'Credits bought outright. A catalogue only — consuming purchased credits needs '
  'a ledger that does not exist yet, so nothing may be sold from here until it does.';

COMMIT;
