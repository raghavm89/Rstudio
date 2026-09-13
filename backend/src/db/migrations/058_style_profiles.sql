-- 058 — style profiles: the character's answer to the look profile.
--
-- A person's look is camera, lens, grain, skin — human photography. A character
-- (subject_type='character', migration 057) has no skin and no lens; its "look"
-- is an ILLUSTRATION STYLE. This adds a parallel per-avatar profile and the
-- vocabulary fragments it emits, reusing the same versioned prompt_vocabulary
-- mechanism the look profile uses, so improving a fragment improves every
-- tenant's output with no action from them.
--
-- The person path (look_profiles, the human facets) is untouched. A character
-- gets a style_profiles row at creation instead of a look_profiles row.
--
-- See claude/character-line-scope.md (Phase C, CA7). The starter vocabulary
-- below is a v1 — expand render styles / palettes as the catalogue grows.

BEGIN;

CREATE TABLE IF NOT EXISTS style_profiles (
  avatar_id          INTEGER     PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
  render_style       TEXT        NOT NULL DEFAULT 'flat_2d',   -- flat_2d | soft_3d | watercolour | claymation | cel_shaded
  palette            TEXT        NOT NULL DEFAULT 'warm',       -- warm | cool | pastel | vivid | muted
  line_weight        TEXT        NOT NULL DEFAULT 'bold',       -- none | fine | bold
  shading            TEXT        NOT NULL DEFAULT 'soft',       -- flat | soft | dramatic
  background         TEXT        NOT NULL DEFAULT 'plain',      -- plain | soft_scene | patterned
  vocabulary_version INTEGER     NOT NULL DEFAULT 1,
  locked_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Character style vocabulary (version 1). UNIQUE (version, facet, option_key) in
-- prompt_vocabulary keeps these from colliding with the human facets, which
-- share the same version. A fragment may be empty ('') by design — line_weight
-- 'none' emits no text, exactly as grain 'none' does for a person.
INSERT INTO prompt_vocabulary (version, facet, option_key, fragment, sort_order) VALUES
  (1, 'render_style', 'flat_2d',     'flat 2D vector illustration, clean bold shapes',                 10),
  (1, 'render_style', 'soft_3d',     'soft 3D rendered character, gentle studio light, subsurface glow',20),
  (1, 'render_style', 'watercolour', 'hand-painted watercolour illustration, soft washes, paper grain', 30),
  (1, 'render_style', 'claymation',  'claymation character, sculpted matte clay, tactile fingerprints', 40),
  (1, 'render_style', 'cel_shaded',  'cel-shaded animation style, crisp ink outlines, flat cel shading',50),

  (1, 'palette', 'warm',   'warm palette of ambers and corals',   10),
  (1, 'palette', 'cool',   'cool palette of teals and blues',      20),
  (1, 'palette', 'pastel', 'soft pastel palette',                  30),
  (1, 'palette', 'vivid',  'vivid saturated palette',              40),
  (1, 'palette', 'muted',  'muted earthy palette',                 50),

  (1, 'line_weight', 'none', '',                          10),
  (1, 'line_weight', 'fine', 'fine delicate linework',    20),
  (1, 'line_weight', 'bold', 'bold confident outlines',   30),

  (1, 'shading', 'flat',     'flat shading, minimal gradients',        10),
  (1, 'shading', 'soft',     'soft smooth shading',                    20),
  (1, 'shading', 'dramatic', 'dramatic high-contrast shading',         30),

  (1, 'background', 'plain',      'clean solid-colour background',           10),
  (1, 'background', 'soft_scene', 'simple softly-blurred scene behind',      20),
  (1, 'background', 'patterned',  'playful patterned background',            30)
ON CONFLICT (version, facet, option_key) DO UPDATE
  SET fragment = EXCLUDED.fragment, sort_order = EXCLUDED.sort_order, active = TRUE;

COMMIT;
