-- 060 — a deeper, India-trending starter template library.
--
-- 059 seeded three formats to prove the machinery. This grows the platform
-- library toward what the product is actually for: trending content for an
-- Indian audience — festival and function looks, GRWM and transition reels,
-- street-food and lifestyle stills, and the ad structures that sell here
-- (festive sale drops, skincare routines, before/after reveals).
--
-- All platform (tenant_id NULL, is_platform TRUE), valid vocabulary keys, shot
-- plans 3–5 frames. A v1 curation — grow it as trends move. ON CONFLICT DO
-- NOTHING so a re-run is safe and 059's three are untouched.

BEGIN;

INSERT INTO content_templates (tenant_id, slug, name, category, kind, frame_count, clip_seconds, is_platform, recipe)
VALUES
  -- ── viral_video (reels) ─────────────────────────────────────────────────
  (NULL, 'transition-fit-check', 'Transition Fit Check', 'viral_video', 'reel', 4, 5, TRUE,
   '{"brief":{"concept":"An outfit-transition reel: casual to festive in a beat-drop cut, ending on a confident pose.","hook":"wait for it","caption_angle":"short, hype, one emoji-light line","trend_source":"manual","slot_type":"outfit"},
     "scene":{"time_of_day":"evening","continuity":{"location_text":"a home doorway with warm fairy lights","wardrobe_text":"casual, then a festive kurta / ethnic outfit"}},
     "shots":[
       {"framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
       {"framing":"full","light_direction":"camera_left","light_quality":"hard","expression_key":"confident","expression_intensity":"high"},
       {"framing":"close","light_direction":"front_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"}
     ]}'::jsonb),

  (NULL, 'grwm-function', 'GRWM for the Function', 'viral_video', 'reel', 4, 5, TRUE,
   '{"brief":{"concept":"A get-ready-with-me for a wedding function: jewellery, dupatta, the final twirl.","hook":"getting ready for shaadi season","caption_angle":"warm, first-person, a small honest aside about the chaos","trend_source":"manual","slot_type":"festival"},
     "scene":{"time_of_day":"afternoon","continuity":{"location_text":"a bright room with a mirror and ethnic wear laid out","wardrobe_text":"a lehenga or saree with jewellery"}},
     "shots":[
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"full","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"high"}
     ]}'::jsonb),

  (NULL, 'day-in-my-life', 'A Day in My Life', 'viral_video', 'reel', 5, 5, TRUE,
   '{"brief":{"concept":"A day-in-my-life reel: morning chai, work, a walk, an evening wind-down — quick relatable cuts.","hook":"a normal day, mostly","caption_angle":"casual, lowercase, relatable","trend_source":"manual","slot_type":"lifestyle"},
     "scene":{"time_of_day":"morning","continuity":{"location_text":"a cosy flat, a desk, a leafy street","wardrobe_text":"comfy everyday wear"}},
     "shots":[
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"sleepy","expression_intensity":"medium"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"medium","light_direction":"front","light_quality":"hard","expression_key":"confident","expression_intensity":"medium"},
       {"framing":"full","light_direction":"camera_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"}
     ]}'::jsonb),

  -- ── ad_video (reels / shorts) ───────────────────────────────────────────
  (NULL, 'festive-sale-drop', 'Festive Sale Drop', 'ad_video', 'reel', 3, 5, TRUE,
   '{"brief":{"concept":"A festive-season sale ad: the offer, an excited reaction, a clear call to shop now.","hook":"the festive sale is LIVE","caption_angle":"urgent, benefit-led, one clear CTA and the dates","trend_source":"manual","slot_type":"product"},
     "scene":{"time_of_day":"afternoon","continuity":{"location_text":"a bright set with festive props and a single accent colour","wardrobe_text":"smart festive-casual"}},
     "shots":[
       {"framing":"medium","light_direction":"camera_right","light_quality":"hard","expression_key":"confident","expression_intensity":"high"},
       {"framing":"close","light_direction":"front","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
       {"framing":"full","light_direction":"front","light_quality":"soft","expression_key":"laughing","expression_intensity":"medium"}
     ]}'::jsonb),

  (NULL, 'skincare-routine-ad', 'Skincare Routine Ad', 'ad_video', 'reel', 4, 5, TRUE,
   '{"brief":{"concept":"A skincare-routine ad: the concern, the steps, the glow — soft and trustworthy.","hook":"my everyday glow routine","caption_angle":"calm, honest, benefit per step, gentle CTA","trend_source":"manual","slot_type":"beauty"},
     "scene":{"time_of_day":"morning","continuity":{"location_text":"a clean bathroom vanity with soft daylight","wardrobe_text":"a plain robe or tee, hair back"}},
     "shots":[
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"medium","light_direction":"front_left","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"}
     ]}'::jsonb),

  (NULL, 'before-after-reveal', 'Before / After Reveal', 'ad_video', 'short', 3, 5, TRUE,
   '{"brief":{"concept":"A before/after product reveal: the problem, the switch, the visibly better after.","hook":"I did not expect this","caption_angle":"punchy, proof-led, one CTA","trend_source":"manual","slot_type":"product"},
     "scene":{"time_of_day":"afternoon","continuity":{"location_text":"a neutral studio, one accent light","wardrobe_text":"a plain outfit so the product leads"}},
     "shots":[
       {"framing":"close","light_direction":"front","light_quality":"hard","expression_key":"anxious","expression_intensity":"medium"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
       {"framing":"close","light_direction":"front_right","light_quality":"soft","expression_key":"confident","expression_intensity":"high"}
     ]}'::jsonb),

  -- ── viral_stills (posts / carousels) ────────────────────────────────────
  (NULL, 'festival-fit-check', 'Festival Fit Check', 'viral_stills', 'carousel', 5, 5, TRUE,
   '{"brief":{"concept":"A festival outfit carousel: five poses of one ethnic look, detail to full length.","hook":"festival fit, rate it","caption_angle":"short, confident, a couple of dry lines","trend_source":"manual","slot_type":"festival"},
     "scene":{"time_of_day":"evening","continuity":{"location_text":"a decorated home corner with diyas and marigold","wardrobe_text":"a festive ethnic outfit with jewellery"}},
     "shots":[
       {"framing":"full","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"high"},
       {"framing":"medium","light_direction":"camera_left","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"close","light_direction":"window","light_quality":"soft","expression_key":"neutral","expression_intensity":"low"},
       {"framing":"medium","light_direction":"camera_right","light_quality":"hard","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"full","light_direction":"front_left","light_quality":"soft","expression_key":"confident","expression_intensity":"medium"}
     ]}'::jsonb),

  (NULL, 'street-food-crawl', 'Street Food Crawl', 'viral_stills', 'carousel', 5, 5, TRUE,
   '{"brief":{"concept":"A street-food carousel: candid stills at a food market — bites, reactions, the scene.","hook":"eating my way through the city","caption_angle":"fun, casual, name the dishes","trend_source":"manual","slot_type":"food"},
     "scene":{"time_of_day":"evening","continuity":{"location_text":"a busy Indian street-food market with warm lights","wardrobe_text":"casual streetwear"}},
     "shots":[
       {"framing":"medium","light_direction":"camera_left","light_quality":"hard","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"close","light_direction":"front","light_quality":"soft","expression_key":"surprised","expression_intensity":"high"},
       {"framing":"full","light_direction":"camera_right","light_quality":"hard","expression_key":"soft_smile","expression_intensity":"medium"},
       {"framing":"close","light_direction":"front_left","light_quality":"soft","expression_key":"laughing","expression_intensity":"high"},
       {"framing":"medium","light_direction":"front","light_quality":"soft","expression_key":"confident","expression_intensity":"low"}
     ]}'::jsonb),

  (NULL, 'chai-sunset', 'Chai & Sunset', 'viral_stills', 'post', 1, 5, TRUE,
   '{"brief":{"concept":"A single aesthetic golden-hour still: chai in hand, calm and warm.","hook":"golden hour, one chai","caption_angle":"soft, short, a little poetic","trend_source":"manual","slot_type":"lifestyle"},
     "scene":{"time_of_day":"evening","continuity":{"location_text":"a balcony at golden hour, low skyline behind","wardrobe_text":"a cosy oversized outfit"}},
     "shots":[
       {"framing":"medium","light_direction":"back_right","light_quality":"soft","expression_key":"soft_smile","expression_intensity":"medium"}
     ]}'::jsonb)
ON CONFLICT DO NOTHING;

COMMIT;
