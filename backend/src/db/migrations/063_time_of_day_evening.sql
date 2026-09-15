-- 063 — seed time_of_day 'evening'
--
-- Several seeded templates (and plenty of GRWM / festive ideas) call for an
-- evening, which the vocabulary never defined — so it clamped to 'afternoon'
-- everywhere. Add it as a first-class option, between golden hour and night.
-- Same discipline as 030/062: a plain physical description of the light, no
-- quality words. Version 1, upsert so a re-run only refreshes the fragment.

INSERT INTO prompt_vocabulary (version, facet, option_key, fragment, sort_order) VALUES
  (1, 'time_of_day', 'evening', 'early evening light after sunset, the sky deepening, warm lamps and window light beginning to carry the scene', 45)
ON CONFLICT (version, facet, option_key) DO UPDATE
  SET fragment = EXCLUDED.fragment, active = TRUE;
