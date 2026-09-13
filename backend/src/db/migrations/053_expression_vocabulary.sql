-- 053_expression_vocabulary.sql
--
-- Six of eleven expressions rendered a neutral face.
--
-- `expressionHint` in buildWorkflow.js was the only thing producing an
-- expression, and it was a hardcoded JS object with five usable entries:
--
--     const light = { soft_smile: …, laughing: …, confident: …, shy: …, sleepy: … };
--     if (shot.expression_blend || shot.expression_follow_on) return 'relaxed neutral expression';
--     return light[shot.expression_key] || 'relaxed neutral expression';
--
-- So `surprised` and `anxious` fell through the `||` to neutral, and
-- `laughing`, `crying`, `weird` and `gym_tired` were caught by the blend check
-- one line above — which also made the `laughing` entry in that object
-- unreachable, dead the day it was written.
--
-- ── The justification, which was not true ────────────────────────────────────
-- The comment said the precise expression "is applied as a separate edit pass
-- over the face region after generation". There is no such pass. Nothing in the
-- codebase reads `blend_ratio`, `base_emotion`, `default_intensity` or
-- `follow_on_pass` beyond the line that returns neutral, and there is no
-- inpaint or edit stage in `STAGES`. The prompt is all there is.
--
-- The cost of that was not a missing feature. A picker offering "Crying" and
-- delivering a calm face is worse than one that does not offer it — and
-- calibration made it worse still, because it measured NEUTRAL geometry, filed
-- it under `preset_key = 'crying'`, and would then have judged real crying
-- frames against a neutral baseline. Which is precisely the bug the whole
-- per-expression gate exists to prevent, arrived at from the other end.
--
-- ── Why the vocabulary and not the object ────────────────────────────────────
-- Expression was the ONE prompt facet living in code. Every other facet —
-- lens, skin, framing, light direction, grain, colour — is a row here,
-- versioned, and improvable for every tenant without a deploy. That is not a
-- stylistic preference; it is why expression was the facet that drifted out of
-- step with its own preset table and stayed that way. A fragment that is
-- missing from this table now fails LOUDLY at prompt assembly, because
-- `fragment(..., { required: true })` throws rather than returning ''.
--
-- Added to version 1 rather than as version 2 on purpose: `look_profiles`
-- pins `vocabulary_version` at persona setup, so a new version would strand
-- every existing avatar on a vocabulary that cannot express anything at all.
-- Improving version 1 in place is the mechanism this table was built for.
--
-- ── How the fragments are written ────────────────────────────────────────────
-- Physically, in face mechanics — eyelids, brow ends, mouth corners — rather
-- than in emotion words. Flux renders what it is told to draw, and "sad" is not
-- something it can draw; a brow drawn up at the inner ends is.
--
-- Deliberately not hyperbolic. The original instinct that a strong expression
-- fights the LoRA is real: an adapter trained on a mostly-neutral seed set
-- resists a hard expression, and pushing harder drifts the identity instead of
-- moving the face. These describe the pose of the face, not its intensity.
--
-- No gendered language, per 052. No quality words, per 026: there is no row
-- here emitting "flawless" or "porcelain", so no combination of picker choices
-- can produce them.

INSERT INTO prompt_vocabulary (version, facet, option_key, fragment, sort_order) VALUES
  (1, 'expression', 'neutral',
   'a relaxed neutral expression, lips closed and level, eyes open and calm', 10),
  (1, 'expression', 'soft_smile',
   'a soft closed-mouth smile, the corners of the mouth slightly raised, a small crease at the outer eyes', 20),
  (1, 'expression', 'laughing',
   'laughing, the mouth open in a wide smile with the upper teeth visible, the eyes narrowed and creased at the outer corners', 30),
  (1, 'expression', 'confident',
   'a level, confident look, the chin steady, the mouth closed and relaxed, the gaze direct to the lens', 40),
  (1, 'expression', 'shy',
   'a slight shy smile, the chin dipped, the gaze angled just off the lens, the lips lightly pressed together', 50),
  (1, 'expression', 'sleepy',
   'heavy-lidded eyes with the upper lids low, the mouth soft and closed, the brow unfurrowed', 60),
  (1, 'expression', 'crying',
   'crying, the eyes wet and reddened along the lower lids, tears on the cheeks, the brows drawn up at their inner ends, the corners of the mouth pulled down', 70),
  (1, 'expression', 'weird',
   'an odd unreadable look, one brow raised higher than the other, the mouth pulled slightly to one side, the eyes narrowed', 80),
  (1, 'expression', 'surprised',
   'surprised, the eyes wide with the upper lids raised, the brows lifted, the mouth fallen slightly open', 90),
  (1, 'expression', 'anxious',
   'an anxious look, the brows drawn together and raised at their inner ends, the lips pressed thin, the eyes fixed and slightly widened', 100),
  (1, 'expression', 'gym_tired',
   'tired after exertion, the upper lids low, the mouth slightly open, a faint tired smile, a light flush across the cheeks', 110)
ON CONFLICT (version, facet, option_key) DO UPDATE
  SET fragment = EXCLUDED.fragment, active = TRUE;

-- These two stopped meaning "do not prompt this".
--
-- They were read as a precondition — a preset carrying either was skipped at
-- prompt assembly and skipped by calibration — for an edit pass that does not
-- exist. They are kept because they carry real design intent about how each
-- expression should eventually be REFINED, and a refinement pass improves a
-- frame that already shows the expression rather than being the only thing
-- that puts it there.
COMMENT ON COLUMN expression_presets.blend_with IS
  'Future refinement hint: a second emotion to blend toward in a post-generation edit pass. NOT a reason to skip prompting the expression — see migration 053.';
COMMENT ON COLUMN expression_presets.follow_on_pass IS
  'Future refinement hint: a named edit pass (e.g. tears_inpaint) that would improve this expression after generation. NOT a reason to skip prompting it — see migration 053.';
