-- 055 — reprice to the frozen offering (v1).
--
-- PRICES + TIERS only. The settled credit denomination (1 still = 1 credit, a
-- budget video = 6, wallet + top-ups — see claude/credit-denomination-settled.md)
-- is a PER-PIECE model, whereas billing today meters per-unit (video_seconds,
-- still_megapixels) and only DISPLAYS credits. Moving to a per-piece credit
-- wallet is a separate billing-core change and is NOT done here. The content
-- entitlements below are interim per-unit translations of the frozen bundles
-- (budget video ~= 30s) so the new tiers work today; the wallet supersedes them.

BEGIN;

-- ── Prices ──────────────────────────────────────────────────────────────────
UPDATE plans SET amount = 700000 WHERE slug = 'max';          -- ₹6,000 -> ₹7,000
UPDATE plans SET sort_order = 3 WHERE slug = 'pro';
UPDATE plans SET sort_order = 4 WHERE slug = 'max';

INSERT INTO plans (name, slug, description, tagline, amount, currency, interval, sort_order, is_active)
VALUES
  ('Catalogue', 'catalogue', 'A ready-made avatar and a month of content.', 'Pick a face, start posting.', 99900, 'INR', 'month', 2, TRUE),
  ('Ultra',     'ultra',     'Agency scale, plus the live AI clone.',       'Everything, at agency scale.', 1500000, 'INR', 'month', 5, TRUE)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, tagline = EXCLUDED.tagline,
      amount = EXCLUDED.amount, currency = EXCLUDED.currency, sort_order = EXCLUDED.sort_order, is_active = TRUE;

-- ── Avatar counts + Ultra realtime bundle (frozen §9) ───────────────────────
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT p.id, v.metric, v.limit_value, v.period, v.notes
  FROM plans p JOIN (VALUES
    ('catalogue', 'avatars',           1,  'lifetime', 'one shared catalogue avatar'),
    ('pro',       'avatars',           1,  'lifetime', 'one custom or clone avatar'),
    ('max',       'avatars',           5,  'lifetime', 'five avatars'),
    ('ultra',     'avatars',          12,  'lifetime', 'twelve avatars'),
    ('ultra',     'realtime_minutes',  60, 'month',    'bundled live-clone minutes')
  ) AS v(slug, metric, limit_value, period, notes) ON v.slug = p.slug
ON CONFLICT (plan_id, metric, period) DO UPDATE
  SET limit_value = EXCLUDED.limit_value, notes = EXCLUDED.notes;

-- Free (plan_id IS NULL): one shared catalogue avatar. NULLs are distinct in a
-- unique index, so ON CONFLICT would not match — replace explicitly.
DELETE FROM studio_entitlements WHERE plan_id IS NULL AND metric = 'avatars' AND period = 'lifetime';
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
VALUES (NULL, 'avatars', 1, 'lifetime', 'one shared catalogue avatar');

-- ── Interim content quotas (per-unit; superseded by the credit wallet) ──────
UPDATE studio_entitlements SET limit_value = 150 WHERE plan_id IS NULL AND metric = 'video_seconds'    AND period = 'month';
UPDATE studio_entitlements SET limit_value = 10  WHERE plan_id IS NULL AND metric = 'still_megapixels' AND period = 'month';

INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes)
SELECT p.id, v.metric, v.limit_value, v.period, v.notes
  FROM plans p JOIN (VALUES
    ('catalogue', 'video_seconds',     600, 'month', '~20 budget videos'),
    ('catalogue', 'still_megapixels',   30, 'month', '~30 stills'),
    ('pro',       'video_seconds',     900, 'month', '~30 budget videos'),
    ('pro',       'still_megapixels',   40, 'month', '~40 stills'),
    ('max',       'video_seconds',    3000, 'month', '~100 budget videos'),
    ('max',       'still_megapixels',  150, 'month', '~150 stills'),
    ('ultra',     'video_seconds',    7500, 'month', '~250 budget videos'),
    ('ultra',     'still_megapixels',  350, 'month', '~350 stills')
  ) AS v(slug, metric, limit_value, period, notes) ON v.slug = p.slug
ON CONFLICT (plan_id, metric, period) DO UPDATE
  SET limit_value = EXCLUDED.limit_value, notes = EXCLUDED.notes;

COMMIT;
