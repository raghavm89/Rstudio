-- 066 — stories become script + open ROLES, browsed by GENRE, cast by the user.
--
-- 065 shipped stories with a fixed cast baked in (specific catalogue slugs). The
-- product decision changed: a Story is now a SCRIPT with open ROLES, browsed by
-- GENRE, and the user CASTS each role from the catalogue (a person or a
-- character) at create time. So:
--   • `content_templates.genre` groups stories on the Story page.
--   • a story's recipe carries `roles: [{ key, label, hint, subject }]` instead of
--     `cast`. One role has key 'lead' (the orchestrator's lead). Scenes reference
--     a role key as each shot's `character`; `subject` ('any'|'person'|'character')
--     is only a hint for the cast picker — any catalogue avatar may fill any role.
--   • applyStory takes a casting map {roleKey: avatarId}; nothing is baked.
--
-- The 065 platform stories are replaced in place with role-based versions, and
-- romance/drama stories are added. Platform rows only (no tenant depends on a
-- template row; shoots don't FK to it), so delete-and-reseed is safe.

BEGIN;

ALTER TABLE content_templates
  ADD COLUMN IF NOT EXISTS genre TEXT;

CREATE INDEX IF NOT EXISTS idx_content_templates_story_genre
  ON content_templates (genre) WHERE is_story;

-- Replace the 065 baked-cast platform stories.
DELETE FROM content_templates
 WHERE is_platform AND is_story
   AND slug IN ('street-food-diary', 'chai-tapri-catchup', 'festival-plans-debate');

INSERT INTO content_templates
  (tenant_id, slug, name, category, kind, genre, frame_count, clip_seconds, is_platform, is_story, recipe)
VALUES
  -- ── slice of life ────────────────────────────────────────────────────────
  (NULL, 'street-food-diary', 'Street Food Diary', 'viral_video', 'reel', 'slice_of_life', 4, 5, TRUE, TRUE,
   '{"genre":"slice_of_life","brief":{"concept":"A first-person street-food diary: one narrator walks a food street, tasting and reacting.","hook":"come eat the whole street with me","caption_angle":"warm, first-person, one honest aside","trend_source":"story","slot_type":"lifestyle"},
     "roles":[{"key":"lead","label":"The narrator","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"evening","continuity":{"location_text":"a busy Indian food street strung with lights","wardrobe_text":"a casual outfit"},
       "shots":[
         {"character":"lead","dialogue":"Okay, we are starting with the chaat. Non-negotiable.","framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
         {"character":"lead","dialogue":"One bite in and I already have no regrets.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
         {"character":"lead","dialogue":"Now the jalebi, still warm. This is the one.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
         {"character":"lead","dialogue":"Full, happy, and doing this again tomorrow.","framing":"full","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"}
       ]}]}'::jsonb),

  -- ── friendship ───────────────────────────────────────────────────────────
  (NULL, 'chai-tapri-catchup', 'Chai Tapri Catch-Up', 'viral_video', 'reel', 'friendship', 4, 5, TRUE, TRUE,
   '{"genre":"friendship","brief":{"concept":"Two friends meet at a roadside chai stall and catch up — a warm, funny back-and-forth.","hook":"the chai tapri talks hit different","caption_angle":"cosy, conversational","trend_source":"story","slot_type":"lifestyle"},
     "roles":[{"key":"lead","label":"The one who asks","hint":"any persona or character","subject":"any"},{"key":"friend","label":"The friend","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"evening","continuity":{"location_text":"a roadside chai tapri with a warm evening glow","wardrobe_text":"casual everyday wear"},
       "shots":[
         {"character":"lead","dialogue":"Two cutting chai, and tell me everything. Do not skip parts.","framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
         {"character":"friend","dialogue":"So I finally quit. I know, I know. Say it.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
         {"character":"lead","dialogue":"I am not saying anything. Okay, I am proud of you.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
         {"character":"friend","dialogue":"See, this is why I tell you first.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"}
       ]}]}'::jsonb),

  -- ── festival ─────────────────────────────────────────────────────────────
  (NULL, 'festival-plans-debate', 'Festival Plans Debate', 'viral_video', 'reel', 'festival', 4, 5, TRUE, TRUE,
   '{"genre":"festival","brief":{"concept":"Two friends debate the festival plan — outfits, timing, who is driving.","hook":"planning the function is a full-time job","caption_angle":"playful, bickering","trend_source":"story","slot_type":"festival"},
     "roles":[{"key":"lead","label":"The organiser","hint":"any persona or character","subject":"any"},{"key":"friend","label":"The other one","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"afternoon","continuity":{"location_text":"a bright living room with ethnic outfits laid out","wardrobe_text":"half-ready festive wear"},
       "shots":[
         {"character":"lead","dialogue":"We are leaving at six. Not six-thirty, not seven. Six.","framing":"medium","light_direction":"window","light_quality":"soft","expression_key":"confident","expression_intensity":"high"},
         {"character":"friend","dialogue":"You said six last year and we left at nine.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
         {"character":"lead","dialogue":"That was one time. Okay, twice. Wear the green one.","framing":"close","light_direction":"window","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
         {"character":"friend","dialogue":"Fine. But I am driving, and I am picking the playlist.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"}
       ]}]}'::jsonb),

  -- ── romance ──────────────────────────────────────────────────────────────
  (NULL, 'first-date-cafe', 'First Date at the Café', 'viral_video', 'reel', 'romance', 4, 5, TRUE, TRUE,
   '{"genre":"romance","brief":{"concept":"Two people on a slightly awkward, sweet first date at a café — nerves, a laugh, a spark.","hook":"first dates are just two people pretending to be calm","caption_angle":"soft, warm, a little nervous","trend_source":"story","slot_type":"lifestyle"},
     "roles":[{"key":"lead","label":"The one who asked","hint":"any persona or character","subject":"any"},{"key":"date","label":"The date","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"evening","continuity":{"location_text":"a warm, softly-lit café with a street-facing window","wardrobe_text":"a nice but not overdone outfit"},
       "shots":[
         {"character":"lead","dialogue":"I rewrote my first sentence like four times. So. Hi.","framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
         {"character":"date","dialogue":"Honestly? Same. I got here twenty minutes early and walked around the block.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
         {"character":"lead","dialogue":"Okay good, so we are both a mess. This is going great already.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
         {"character":"date","dialogue":"Same time next week? I will pretend to be calm again.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"high"}
       ]}]}'::jsonb),

  (NULL, 'rooftop-confession', 'The Rooftop Confession', 'viral_video', 'reel', 'romance', 4, 5, TRUE, TRUE,
   '{"genre":"romance","brief":{"concept":"On a rooftop at dusk, one finally says the thing they have been holding back.","hook":"say the thing. just say it.","caption_angle":"tender, a held breath, a soft landing","trend_source":"story","slot_type":"lifestyle"},
     "roles":[{"key":"lead","label":"The one confessing","hint":"any persona or character","subject":"any"},{"key":"other","label":"The other one","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"evening","continuity":{"location_text":"a small rooftop at dusk with string lights and a low skyline","wardrobe_text":"casual evening wear"},
       "shots":[
         {"character":"lead","dialogue":"Okay. I have been trying to say this for a while, so just let me.","framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"neutral","expression_intensity":"medium"},
         {"character":"other","dialogue":"...I am listening. Take your time.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"low"},
         {"character":"lead","dialogue":"It has always been you. That is the whole thing. That is it.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"},
         {"character":"other","dialogue":"You could have said that on the ground floor, you know.","framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"}
       ]}]}'::jsonb),

  -- ── drama ────────────────────────────────────────────────────────────────
  (NULL, 'the-difficult-talk', 'The Difficult Talk', 'viral_video', 'reel', 'drama', 4, 5, TRUE, TRUE,
   '{"genre":"drama","brief":{"concept":"Two people finally have the conversation they have been avoiding — quiet, honest, unresolved.","hook":"some talks you cannot keep postponing","caption_angle":"restrained, real, no easy bow","trend_source":"story","slot_type":"lifestyle"},
     "roles":[{"key":"lead","label":"The one who starts it","hint":"any persona or character","subject":"any"},{"key":"other","label":"The other one","hint":"any persona or character","subject":"any"}],
     "scenes":[{"time_of_day":"evening","continuity":{"location_text":"a dim living room, two chairs, low lamp light","wardrobe_text":"plain home clothes"},
       "shots":[
         {"character":"lead","dialogue":"We keep saying we will talk later. It is later.","framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"neutral","expression_intensity":"medium"},
         {"character":"other","dialogue":"I know. I was hoping if we waited long enough it would fix itself.","framing":"close","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
         {"character":"lead","dialogue":"It did not. But I am still here, and I want to try.","framing":"close","light_direction":"camera_left","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"},
         {"character":"other","dialogue":"Okay. Then let us actually talk. Properly, this time.","framing":"medium","light_direction":"camera_right","light_quality":"soft","expression_key":"neutral","expression_intensity":"medium"}
       ]}]}'::jsonb)
ON CONFLICT DO NOTHING;

COMMIT;
