-- 062 — two lighting directions the templates already ask for
--
-- Several seeded templates (GRWM, skincare, Ganesh-Chaturthi glow-up) call for
-- `light_direction` values the vocabulary never defined: `window` and
-- `backlit`. Until now createShoot's clamp quietly rewrote them to plain
-- camera-left side light, so the template's intended look — soft window daylight,
-- or a bright backlit halo — never rendered. These are real, common looks worth
-- having, so seed them as first-class options rather than clamping them away.
--
-- Same closed-vocabulary discipline as 030/052/053: no quality words
-- ("flawless", "poreless"), no gendered language — just a physical description
-- of where the light comes from and what it does to the face. Version 1, the
-- version every current look/style profile points at. Upsert so a re-run only
-- refreshes the fragment. sort_order continues after `top` (80).

INSERT INTO prompt_vocabulary (version, facet, option_key, fragment, sort_order) VALUES
  (1, 'light_direction', 'window',
   'lit by soft daylight from a window to one side, a broad gentle key that falls away naturally across the face, the bright shape of the window mirrored as catchlights in the eyes', 90),
  (1, 'light_direction', 'backlit',
   'backlit from behind, a bright rim tracing the hair and the edge of the shoulders with a soft halo of light, the face held in even, open shade as the light wraps just onto the cheeks', 100)
ON CONFLICT (version, facet, option_key) DO UPDATE
  SET fragment = EXCLUDED.fragment, active = TRUE;
