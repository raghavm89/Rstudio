-- 043_fx_100.sql
--
-- Repriced at ₹100 to the dollar.
--
-- 042's allowances were tuned at ₹88. At ₹100 the same grants become −7.8% and
-- −14.3%: the exchange rate is the input nobody controls, and a twelve percent
-- move was enough to turn a positive plan negative. That sensitivity was written
-- down in 042 precisely so this would be a two-line change rather than a
-- discovery.
--
--     video   $0.022/s → ₹2.20 per credit
--     stills  $0.035/MP → ₹1.75 per credit (a megapixel buys two)
--
--     Pro  ₹2,000 →   880 credits   ( 800s video +  40 MP)   +5.0%
--     Max  ₹6,000 → 2,800 credits   (2450s video + 175 MP)    0.0%
--
-- Worst case as before: every credit spent on generative video. A lipsync-heavy
-- month costs roughly a fifth of that.
--
-- ── The splits are not gamed ────────────────────────────────────────────────
-- Stills are the cheaper credit (₹1.75 against ₹2.20), so moving allowance into
-- stills would raise the headline number at the same cost — Pro could advertise
-- 1,000 credits by granting fewer video seconds. That would be a shell game on a
-- product people buy for video, so the split stays roughly where it was: stills
-- are about a tenth of Pro's credits and an eighth of Max's.
--
-- ⚠ The top-up is now well under water. ₹500 for 300 credits is ₹1.67 against a
-- ₹2.20 marginal cost — every pack sold to a heavy generative user loses about
-- ₹160. Break-even at this rate is ₹500 for 227 credits; ₹500 for 200 (₹2.50)
-- would clear cost and give Pro users a reason to move up rather than top up
-- forever. Left at 300 because it is a stated decision, not an oversight —
-- but it cannot survive checkout being wired.

BEGIN;

UPDATE studio_entitlements e SET limit_value = v.limit_value, notes = v.notes
  FROM (VALUES
      ('pro', 'video_seconds',     800, 'month',    'about 13 minutes of generated video'),
      ('pro', 'still_megapixels',   40, 'month',    'full resolution, four candidates'),
      ('max', 'video_seconds',    2450, 'month',    'about 40 minutes of generated video'),
      ('max', 'still_megapixels',  175, 'month',    'full resolution, four candidates')
    ) AS v(slug, metric, limit_value, period, notes)
  JOIN plans p ON p.slug = v.slug
 WHERE e.plan_id = p.id AND e.metric = v.metric AND e.period = v.period;

COMMIT;
