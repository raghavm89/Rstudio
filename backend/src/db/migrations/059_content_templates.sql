-- 059 — content templates: reusable viral/ad recipes applied onto an avatar.
--
-- A template is a saved SHOOT recipe — a format (reel / carousel / …) plus a
-- brief (concept, hook, caption angle) and a shot-by-shot plan (framing,
-- expression, pose, light). Applying one to an avatar is exactly a
-- `Orchestrator.createShoot` with the recipe's kind/frame_count/brief/shots, so
-- "pick a viral format, one click" reuses the whole render pipeline.
--
-- Two sources (both, per the product decision):
--   • PLATFORM templates — tenant_id NULL, is_platform = TRUE — a curated library
--     every tenant browses (like the avatar catalogue).
--   • TENANT templates — tenant_id set — a user's own, incl. ones saved from a
--     shoot they liked. An admin can promote one to the library (is_platform).
--
-- Categories map to kinds: ad_video / viral_video are reels or shorts; viral
-- stills are posts or carousels. The category↔kind rule is enforced in the model
-- (clearer errors than a CHECK), the value domains here.

BEGIN;

CREATE TABLE IF NOT EXISTS content_templates (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER     REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-authored
  slug         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL,     -- ad_video | viral_video | viral_stills
  kind         TEXT        NOT NULL,     -- post | carousel | reel | short | longform
  frame_count  INTEGER     NOT NULL DEFAULT 4 CHECK (frame_count BETWEEN 1 AND 10),
  clip_seconds INTEGER     NOT NULL DEFAULT 5 CHECK (clip_seconds BETWEEN 2 AND 10),
  recipe       JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- { brief, scene, shots: [...] }
  cover_url    TEXT,
  is_platform  BOOLEAN     NOT NULL DEFAULT FALSE,          -- visible to every tenant
  status       TEXT        NOT NULL DEFAULT 'ready',        -- draft | ready
  created_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT content_templates_category_allowed CHECK (category IN ('ad_video','viral_video','viral_stills')),
  CONSTRAINT content_templates_kind_allowed     CHECK (kind IN ('post','carousel','reel','short','longform'))
);

-- A tenant's slugs are unique to them; platform slugs (NULL tenant, distinct in a
-- normal unique index) get their own partial unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_templates_tenant_slug
  ON content_templates (tenant_id, slug) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_templates_platform_slug
  ON content_templates (slug) WHERE tenant_id IS NULL;

-- Browse queries filter is_platform across ALL tenants, so a partial index keeps
-- a private template from ever being scanned by the shared-library query.
CREATE INDEX IF NOT EXISTS idx_content_templates_platform
  ON content_templates (is_platform) WHERE is_platform;
CREATE INDEX IF NOT EXISTS idx_content_templates_tenant
  ON content_templates (tenant_id);

-- ── Starter platform library (v1) ───────────────────────────────────────────
INSERT INTO content_templates (tenant_id, slug, name, category, kind, frame_count, clip_seconds, is_platform, recipe)
VALUES
  (NULL, 'grwm-reel', 'Get Ready With Me', 'viral_video', 'reel', 4, 5, TRUE,
   '{"brief":{"concept":"A get-ready-with-me reel: quick cuts from bare-faced to done, ending on a confident look.","hook":"come get ready with me","caption_angle":"relatable, first-person, one small honest aside","trend_source":"manual","slot_type":"grwm"},
     "scene":{"time_of_day":"morning","continuity":{"location_text":"a bright bedroom with soft window light","wardrobe_text":"a plain fitted top"}},
     "shots":[
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"neutral","expression_intensity":"medium"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"confident","expression_intensity":"high"}
     ]}'::jsonb),

  (NULL, 'product-drop-ad', 'Product Drop Ad', 'ad_video', 'reel', 3, 5, TRUE,
   '{"brief":{"concept":"A punchy product-drop ad: the reveal, the reaction, the call to action.","hook":"you asked, it is here","caption_angle":"confident, benefit-led, one clear CTA","trend_source":"manual","slot_type":"product"},
     "scene":{"time_of_day":"afternoon","continuity":{"location_text":"a clean studio with a single accent colour","wardrobe_text":"a smart casual outfit"}},
     "shots":[
       {"framing":"medium","light_direction":"camera_right","light_quality":"hard","expression_key":"confident","expression_intensity":"high"},
       {"framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
       {"framing":"full","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"}
     ]}'::jsonb),

  (NULL, 'weekend-photo-dump', 'Weekend Photo Dump', 'viral_stills', 'carousel', 5, 5, TRUE,
   '{"brief":{"concept":"A candid weekend photo dump: five off-guard, in-the-moment stills that read as a real day out.","hook":"a normal weekend, mostly","caption_angle":"casual, lowercase, a few dry one-liners","trend_source":"manual","slot_type":"lifestyle"},
     "scene":{"time_of_day":"afternoon","continuity":{"location_text":"a sunny street and a small cafe","wardrobe_text":"an everyday casual outfit"}},
     "shots":[
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"full","light_direction":"front","light_quality":"hard","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"}
     ]}'::jsonb)
ON CONFLICT DO NOTHING;

COMMIT;
