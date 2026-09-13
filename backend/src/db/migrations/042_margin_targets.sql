-- 042_margin_targets.sql
--
-- Credits cut to the allowance the prices can actually carry.
--
-- 041 set Pro at 1,200 credits and Max at 4,000, which at full utilisation on
-- generative video was −16% and −29%: plans that lost more the better they sold.
-- The prices are unchanged; the allowances now match them.
--
--     Pro  ₹2,000 → 1,000 credits   ( 900s video +  50 MP stills)   +5.2%
--     Max  ₹6,000 → 3,200 credits   (2800s video + 200 MP stills)   −0.6%
--
-- Both figured at the WORST case — every credit spent on generative video at
-- fal's $0.022/s, ₹88 to the dollar. Real mixes are cheaper: talking-head
-- lipsync runs $0.005–0.017/s, so the everyday margin is well above these.
--
-- ── Two things worth knowing before touching these again ────────────────────
--
-- 1. STILLS ARE THE CHEAPER CREDIT. A credit spent on video costs ₹1.94; a
--    credit spent on stills costs ₹1.54, because a megapixel is ₹3.08 and buys
--    two credits. Shifting allowance from video to stills therefore raises the
--    headline credit number at the same cost. If a bigger number is wanted on
--    the pricing page, that is the lever — not the price.
--
-- 2. MAX HAS NO BUFFER, BY REQUEST. It is targeted at break-even, so there is
--    nothing absorbing a move in the exchange rate:
--
--        ₹84/$   Pro +9.5%   Max +4.0%
--        ₹88/$   Pro +5.2%   Max −0.6%
--        ₹92/$   Pro +0.9%   Max −5.2%
--
--    The rupee is the input nobody controls and the one most likely to move.
--    Max is a deliberate loss-leader for volume at anything past ₹88.

BEGIN;

UPDATE studio_entitlements e SET limit_value = v.limit_value, notes = v.notes
  FROM (VALUES
      ('pro', 'video_seconds',     900, 'month',    'about 15 minutes of generated video'),
      ('pro', 'still_megapixels',   50, 'month',    'full resolution, four candidates'),
      ('max', 'video_seconds',    2800, 'month',    'about 46 minutes of generated video'),
      ('max', 'still_megapixels',  200, 'month',    'full resolution, four candidates')
    ) AS v(slug, metric, limit_value, period, notes)
  JOIN plans p ON p.slug = v.slug
 WHERE e.plan_id = p.id AND e.metric = v.metric AND e.period = v.period;

COMMIT;
