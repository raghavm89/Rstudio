-- 040_plans_credits.sql
--
-- Free / Pro / Max, and credits as the unit customers see.
--
-- ── Credits do not replace the meters ───────────────────────────────────────
-- The pricing decision on record is "meter the paid side in video seconds, not
-- posts or credits", because a second maps one-to-one onto the Seedance bill and
-- an abstract unit does not. That still holds. Credits are a PRESENTATION layer
-- over the same counters: 1 credit = 1 generated second of video, 2 credits =
-- 1 megapixel of stills. Nothing new is stored, nothing is double-counted, and
-- reading a bill still tells you what it cost.
--
-- The alternative — a credit balance table decremented alongside the counters —
-- would be two sources of truth for one fact, and they would disagree the first
-- time a job failed between the two writes.
--
-- ── Why razorpay_plan_id becomes nullable ───────────────────────────────────
-- `plans` has required it since 001. A plan has to exist in the product before
-- it exists in Razorpay — the page has to show Pro before anyone can buy Pro —
-- and the alternative is seeding invented ids that collide with the real ones
-- the day checkout is wired.

BEGIN;

ALTER TABLE plans
  ALTER COLUMN razorpay_plan_id DROP NOT NULL,
  -- A stable handle for code and URLs. `name` is a display string and will be
  -- rewritten by whoever edits the pricing page; `id` is an integer that differs
  -- between environments. Neither is safe to branch on.
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS tagline TEXT,
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_slug_unique') THEN
    ALTER TABLE plans ADD CONSTRAINT plans_slug_unique UNIQUE (slug);
  END IF;
END $$;

-- `amount` is in the currency's minor unit, which for INR is paise — the unit
-- Razorpay takes, so no conversion happens at checkout time where a factor of
-- 100 is easiest to get wrong.
INSERT INTO plans (name, slug, description, tagline, amount, currency, interval, sort_order, is_active)
VALUES
  ('Pro', 'pro',
   'For a creator running one persona properly.',
   'Everything published, one persona.',
   1200000, 'INR', 'month', 2, TRUE),
  ('Max', 'max',
   'For an agency running several.',
   'Several personas, several channels.',
   2500000, 'INR', 'month', 3, TRUE)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      tagline = EXCLUDED.tagline,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      sort_order = EXCLUDED.sort_order;

-- Entitlements, in the same metrics the free tier already uses — so free and
-- paid stay enforced by one code path rather than two.
--
-- 6,000 video seconds is 100 minutes a month; 15,000 is 250. Against the
-- recorded raw-compute range those sit inside the margin at the list prices
-- above, but they are the number to revisit first if the margin moves.
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT p.id, v.metric, v.limit_value, v.period, v.notes
  FROM plans p
  JOIN (VALUES
      ('pro', 'video_seconds',     6000, 'month',    '100 minutes of generated video'),
      ('pro', 'still_megapixels',  3000, 'month',    'full resolution, four candidates'),
      ('pro', 'avatars',              3, 'lifetime', 'three personas'),
      ('pro', 'faces_claimed',        1, 'lifetime', 'one face claimed exclusively'),
      ('pro', 'publishes',          100, 'month',    'publishing to Instagram and YouTube'),
      ('max', 'video_seconds',    15000, 'month',    '250 minutes of generated video'),
      ('max', 'still_megapixels',  8000, 'month',    'full resolution, four candidates'),
      ('max', 'avatars',             10, 'lifetime', 'ten personas'),
      ('max', 'faces_claimed',        5, 'lifetime', 'five faces claimed exclusively'),
      ('max', 'publishes',          500, 'month',    'publishing to Instagram and YouTube')
    ) AS v(slug, metric, limit_value, period, notes)
    ON v.slug = p.slug
ON CONFLICT (plan_id, metric, period) DO UPDATE
  SET limit_value = EXCLUDED.limit_value, notes = EXCLUDED.notes;

-- Name the free tier so the pricing page can show three cards from one query
-- rather than two rows and a hardcoded third.
INSERT INTO plans (name, slug, description, tagline, amount, currency, interval, sort_order, is_active)
VALUES ('Free', 'free',
        'Enough to prove the thing works.',
        'Make it. Publishing is the wall.',
        0, 'INR', 'month', 1, TRUE)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description,
      tagline = EXCLUDED.tagline, amount = EXCLUDED.amount, sort_order = EXCLUDED.sort_order;

COMMENT ON COLUMN plans.slug IS
  'Stable handle for code and URLs. Branch on this, never on name or id.';
COMMENT ON COLUMN plans.amount IS
  'Minor units — paise for INR. The unit Razorpay takes, so nothing multiplies by 100 at checkout.';

COMMIT;
