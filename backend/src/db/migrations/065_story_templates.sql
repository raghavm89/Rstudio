-- 065 — story templates: ready-to-go multi-character story reels.
--
-- 059/060 seeded single-avatar recipes: pick a format, apply it to YOUR avatar.
-- A STORY template is the facelessreels-style offering — pick a story, and a reel
-- is created with its cast already baked in (catalogue avatars), no avatar
-- picker. The recipe carries the CAST and the DIALOGUE, so applying one is a
-- multi-character shoot (shot-reverse-shot) the tenant never had to author.
--
-- What makes a template a story (`is_story = TRUE`):
--   • recipe.cast = [{ key, slug, role }] — references CATALOGUE avatars by slug.
--     One member is the lead (role 'lead', key 'lead'); the rest are co-stars.
--   • recipe.scenes = [{ ...scene, shots: [{ character:<castKey>, dialogue, ... }] }]
--     — the same `scenes` shape createShoot already accepts, with a per-shot
--     `character` (which cast member is on screen) and `dialogue` (their line).
--
-- Applying a story (contentTemplate.applyStory) resolves each cast slug to a
-- catalogue avatar, auto-selects it for the tenant, then runs the ordinary
-- multi-character createShoot. Nothing here renders or charges — every gate,
-- cost and quota lives in the orchestrator, exactly as for a normal template.
--
-- A story only applies once its WHOLE cast is in the catalogue. The library is
-- seeded ahead of the catalogue: listStories reports each story's availability
-- so the UI shows "coming soon" for a cast not yet built, and the story lights
-- up on its own as the catalogue fills (roadmap Week 2). The single-narrator
-- story (Aanya only) is applyable today.

BEGIN;

ALTER TABLE content_templates
  ADD COLUMN IF NOT EXISTS is_story BOOLEAN NOT NULL DEFAULT FALSE;

-- The story library query filters is_story across the platform; a partial index
-- keeps it cheap and touches nothing the existing template queries scan.
CREATE INDEX IF NOT EXISTS idx_content_templates_story
  ON content_templates (is_story) WHERE is_story;

-- ── Starter story library (v1) ──────────────────────────────────────────────
-- All platform (tenant_id NULL, is_platform TRUE, is_story TRUE), category
-- viral_video / kind reel. Casts reference catalogue slugs; frame_count is the
-- total shot count across scenes. Valid vocabulary keys only. ON CONFLICT DO
-- NOTHING so a re-run is safe.
INSERT INTO content_templates
  (tenant_id, slug, name, category, kind, frame_count, clip_seconds, is_platform, is_story, recipe)
VALUES
  -- Single-narrator story (Aanya only) — applyable today; proves the flow.
  (NULL, 'street-food-diary', 'Street Food Diary', 'viral_video', 'reel', 4, 5, TRUE, TRUE,
   '{"brief":{"concept":"A first-person street-food diary: one narrator walks a food street, tasting and reacting, ending on a favourite.","hook":"come eat the whole street with me","caption_angle":"warm, first-person, one honest aside","trend_source":"story","slot_type":"lifestyle"},
     "cast":[{"key":"lead","slug":"aanya-kapoor","role":"lead","name":"Aanya"}],
     "scenes":[
       {"time_of_day":"evening","continuity":{"location_text":"a busy Indian food street strung with lights","wardrobe_text":"a casual kurti"},
        "shots":[
          {"character":"lead","dialogue":"Okay, we are starting with the chaat. Non-negotiable.","framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
          {"character":"lead","dialogue":"One bite in and I already have no regrets.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
          {"character":"lead","dialogue":"Now the jalebi, still warm. This is the one.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
          {"character":"lead","dialogue":"Full, happy, and doing this again tomorrow.","framing":"full","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"}
        ]}
     ]}'::jsonb),

  -- Two-hander shot-reverse-shot — lights up when the co-star is catalogued.
  (NULL, 'chai-tapri-catchup', 'Chai Tapri Catch-Up', 'viral_video', 'reel', 4, 5, TRUE, TRUE,
   '{"brief":{"concept":"Two friends meet at a roadside chai stall and catch up — a warm, funny back-and-forth over cutting chai.","hook":"the chai tapri talks hit different","caption_angle":"cosy, conversational, a little dramatic","trend_source":"story","slot_type":"lifestyle"},
     "cast":[{"key":"lead","slug":"aanya-kapoor","role":"lead","name":"Aanya"},{"key":"rohan","slug":"rohan-mehra","role":"costar","name":"Rohan"}],
     "scenes":[
       {"time_of_day":"evening","continuity":{"location_text":"a roadside chai tapri with a warm evening glow","wardrobe_text":"casual everyday wear"},
        "shots":[
          {"character":"lead","dialogue":"Two cutting chai, and tell me everything. Do not skip parts.","framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
          {"character":"rohan","dialogue":"So I finally quit. I know, I know. Say it.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
          {"character":"lead","dialogue":"I am not saying anything. Okay, I am proud of you.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
          {"character":"rohan","dialogue":"See, this is why I tell you first.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"}
        ]}
     ]}'::jsonb),

  -- Two-hander festival planning debate — lights up when the co-star is catalogued.
  (NULL, 'festival-plans-debate', 'Festival Plans Debate', 'viral_video', 'reel', 4, 5, TRUE, TRUE,
   '{"brief":{"concept":"Two friends debate the festival plan — outfits, timing, who is driving — the friendly argument everyone has.","hook":"planning the function is a full-time job","caption_angle":"playful, bickering, relatable","trend_source":"story","slot_type":"festival"},
     "cast":[{"key":"lead","slug":"aanya-kapoor","role":"lead","name":"Aanya"},{"key":"meera","slug":"meera-iyer","role":"costar","name":"Meera"}],
     "scenes":[
       {"time_of_day":"afternoon","continuity":{"location_text":"a bright living room with ethnic outfits laid out","wardrobe_text":"half-ready festive wear"},
        "shots":[
          {"character":"lead","dialogue":"We are leaving at six. Not six-thirty, not seven. Six.","framing":"medium","light_direction":"window","light_quality":"soft","expression_key":"confident","expression_intensity":"high"},
          {"character":"meera","dialogue":"You said six last year and we left at nine.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
          {"character":"lead","dialogue":"That was one time. Okay, twice. Wear the green one.","framing":"close","light_direction":"window","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
          {"character":"meera","dialogue":"Fine. But I am driving, and I am picking the playlist.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"}
        ]}
     ]}'::jsonb)
ON CONFLICT DO NOTHING;

COMMIT;
