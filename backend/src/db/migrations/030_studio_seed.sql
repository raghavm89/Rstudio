-- ── 030_studio_seed.sql ──────────────────────────────────────────────────────
-- Platform-level seed data: the prompt vocabulary, the expression presets and
-- the free-tier entitlements.
--
-- THE MOST IMPORTANT PROPERTY OF THIS FILE IS WHAT IT DOES NOT CONTAIN.
-- No row anywhere emits "flawless skin", "porcelain complexion", "perfect
-- symmetry", "airbrushed" or their relatives. Those phrases instruct the model
-- to erase exactly the texture that makes a face read as real, and because the
-- creator picks options rather than typing prompts, a phrase absent from this
-- table can never reach a model — by anyone, ever. Subtraction is structural
-- here rather than a rule someone has to remember.
--
-- Re-running is safe: every insert is ON CONFLICT DO NOTHING.

-- 1. Prompt vocabulary, version 1 ---------------------------------------------
INSERT INTO prompt_vocabulary (version, facet, option_key, fragment, sort_order) VALUES
  -- Base look → paired with a base checkpoint in look_profiles
  (1, 'base_look', 'editorial',       'clean editorial lighting, low colour noise, magazine finish', 10),
  (1, 'base_look', 'warm_film',       'shot on film, halated highlights, soft highlight roll-off', 20),
  (1, 'base_look', 'clean_digital',   'neutral digital capture, high micro-contrast', 30),
  (1, 'base_look', 'grainy_street',   'available light, candid street photography feel', 40),

  -- Lens. The list stops at 35mm on purpose: wider distorts facial proportions,
  -- so it is simply not offered anywhere in the interface.
  (1, 'lens', 'portrait_85',      '85mm f/1.4 portrait lens, shallow depth of field, eyes tack-sharp, soft bokeh background, gentle feature compression', 10),
  (1, 'lens', 'natural_50',       '50mm f/1.8 lens, natural perspective, moderate depth of field', 20),
  (1, 'lens', 'environmental_35', '35mm f/2 lens, environmental framing, the room visible behind the subject', 30),

  -- Colour grade
  (1, 'colour', 'warm',     'warm colour grade, golden skin tones', 10),
  (1, 'colour', 'neutral',  'neutral colour grade, accurate skin tones', 20),
  (1, 'colour', 'cool',     'cool colour grade, blue-leaning shadows', 30),
  (1, 'colour', 'contrast', 'high contrast grade, deep shadows, bright highlights', 40),

  -- Grain
  (1, 'grain', 'none',    '', 10),
  (1, 'grain', 'fine',    'fine film grain', 20),
  (1, 'grain', 'visible', 'visible film grain, analogue texture', 30),

  -- Skin. Pores, scattering, oiliness and freckles move together because they
  -- are not independent in practice.
  (1, 'skin', 'subtle',   'natural skin texture, fine pores, subsurface scattering', 10),
  (1, 'skin', 'natural',  'visible skin pores, natural subsurface scattering, slight skin oiliness, faint freckles', 20),
  (1, 'skin', 'textured', 'pronounced skin texture, visible pores and fine lines, natural blemishes, subsurface scattering, faint freckles across the nose and cheeks', 30),

  -- Structural realism toggles
  (1, 'asymmetry',   'on', 'natural facial asymmetry, slightly uneven features', 10),
  (1, 'asymmetry',   'off', '', 20),
  (1, 'hair_detail', 'on', 'individual hair strands visible at the hairline, natural flyaways, realistic hair sheen with strand-to-strand variation', 10),
  (1, 'hair_detail', 'off', '', 20),

  -- Light direction. The single most valuable control on the shot editor:
  -- direction is what places catchlights in the eyes. Without it they render
  -- flat and painted.
  (1, 'light_direction', 'front',        'lit from directly in front of the subject, even illumination, catchlights centred in the eyes', 10),
  (1, 'light_direction', 'camera_left',  'lit from camera left, catchlights in the eyes, gentle shadow falling to camera right', 20),
  (1, 'light_direction', 'camera_right', 'lit from camera right, catchlights in the eyes, gentle shadow falling to camera left', 30),
  (1, 'light_direction', 'front_left',   'lit from front camera left at 45 degrees, sculpted cheekbone shadow, catchlights in the eyes', 40),
  (1, 'light_direction', 'front_right',  'lit from front camera right at 45 degrees, sculpted cheekbone shadow, catchlights in the eyes', 50),
  (1, 'light_direction', 'back_left',    'backlit from camera left, rim light along the jaw and shoulder, hair edge-lit', 60),
  (1, 'light_direction', 'back_right',   'backlit from camera right, rim light along the jaw and shoulder, hair edge-lit', 70),
  (1, 'light_direction', 'top',          'lit from above, short shadows under the brow and nose', 80),

  -- Light quality
  (1, 'light_quality', 'soft', 'soft diffused light, gradual shadow edges', 10),
  (1, 'light_quality', 'hard', 'hard directional light, crisp shadow edges', 20),

  -- Time of day. Combines with direction and quality into one lighting phrase.
  (1, 'time_of_day', 'morning',   'early morning light, cool and clear', 10),
  (1, 'time_of_day', 'midday',    'midday light, bright and overhead', 20),
  (1, 'time_of_day', 'afternoon', 'warm afternoon light', 30),
  (1, 'time_of_day', 'golden',    'golden hour light, low warm sun', 40),
  (1, 'time_of_day', 'night',     'night, warm practical lights in frame', 50),

  -- Framing. Also selects which face-QC threshold applies: a wide shot has less
  -- face to measure than a close-up.
  (1, 'framing', 'close',  'close-up portrait, head and shoulders', 10),
  (1, 'framing', 'medium', 'medium shot, waist up', 20),
  (1, 'framing', 'full',   'full body shot', 30),
  (1, 'framing', 'wide',   'wide environmental shot, subject small in frame', 40),

  -- Always appended last.
  (1, 'quality', 'base', 'photorealistic, sharp focus on the eyes, natural colour, high detail', 10)
ON CONFLICT (version, facet, option_key) DO NOTHING;

-- 2. Expression presets -------------------------------------------------------
-- A button is a stored recipe. base_emotion is one of the twelve the expression
-- editor supports; anything else is a blend or a multi-pass recipe.
--
-- Note how the three examples that started this design map three different ways:
--   crying — not one of the twelve: sad at strong intensity PLUS a tears pass
--   weird  — not an emotion at all: contempt blended with confused, low
--   soft   — not an expression: it is light quality, and lives in the vocabulary
INSERT INTO expression_presets
  (tenant_id, key, label, base_emotion, blend_with, blend_ratio, default_intensity, follow_on_pass, sort_order) VALUES
  (NULL, 'neutral',    'Neutral',    'confident', NULL,       NULL,  'light',  NULL,            10),
  (NULL, 'soft_smile', 'Soft smile', 'happy',     NULL,       NULL,  'light',  NULL,            20),
  (NULL, 'laughing',   'Laughing',   'happy',     'surprised', 0.250, 'strong', NULL,           30),
  (NULL, 'confident',  'Confident',  'confident', NULL,       NULL,  'medium', NULL,            40),
  (NULL, 'shy',        'Shy',        'shy',       NULL,       NULL,  'medium', NULL,            50),
  (NULL, 'sleepy',     'Sleepy',     'sleepy',    NULL,       NULL,  'medium', NULL,            60),
  (NULL, 'crying',     'Crying',     'sad',       NULL,       NULL,  'strong', 'tears_inpaint', 70),
  (NULL, 'weird',      'Weird',      'contempt',  'confused',  0.500, 'light',  NULL,           80),
  (NULL, 'surprised',  'Surprised',  'surprised', NULL,       NULL,  'medium', NULL,            90),
  (NULL, 'anxious',    'Anxious',    'anxious',   NULL,       NULL,  'medium', NULL,           100),
  (NULL, 'gym_tired',  'Gym tired',  'sleepy',    'happy',     0.300, 'medium', NULL,          110)
ON CONFLICT DO NOTHING;

-- 3. Free-tier entitlements ---------------------------------------------------
-- plan_id NULL = free tier.
--
-- video_seconds is 240, not 180. "Three videos, up to 60 seconds" means three
-- SUCCESSFUL videos to a user, but every re-roll is a full provider bill — ten
-- attempts to land three keepers is real money from an account paying nothing.
-- So the internal budget is GENERATED seconds with one re-roll of headroom, and
-- the UI shows what remains before it is spent rather than after.
--
-- publishes is 1 per LIFETIME, not per month: one end-to-end post that proves
-- the loop, after which the wall comes down. Publishing is the wall, not
-- generation — let them make the thing, charge them to send it.
INSERT INTO studio_entitlements (plan_id, metric, limit_value, period, notes) VALUES
  (NULL, 'video_seconds',     240, 'month',    '3 videos up to 60s, plus one re-roll of headroom'),
  (NULL, 'still_megapixels',   60, 'month',    '1 MP per still, one candidate, watermarked'),
  (NULL, 'avatars',             1, 'lifetime', 'one persona on a catalogue face'),
  (NULL, 'faces_claimed',       0, 'lifetime', 'claiming a face exclusively is a paid action'),
  (NULL, 'publishes',           1, 'lifetime', 'one free publish, once — proves the loop, then the wall')
ON CONFLICT DO NOTHING;
