'use strict';

/**
 * Idea -> planned shoot. The "creative director".
 *
 * Turns a free-text idea ("a GRWM for a Mumbai monsoon evening, ending with
 * chai on the balcony") into a full plan: a brief (concept / hook / caption
 * angle), a scene (time of day + location & wardrobe as the continuity TEXT the
 * prompt stage actually reads), and one shot row per frame using ONLY the
 * picker vocabulary. It then hands that to Orchestrator.createShoot — same
 * pipeline, same quota. The only new thing is that the plan came from a model
 * instead of a form. Mirrors copyStage's Anthropic usage.
 *
 * What the model may NOT touch: the creator's face/identity (fixed by the LoRA
 * + identity block). It writes the world around her.
 */

const pool = require('../../config/db');
const Orchestrator = require('./orchestrator');
const { pickModel } = require('./anthropicModel');
const PlanFeedback = require('./planFeedback');
const StoryCast = require('./storyCast');

const FRAMING = ['close', 'medium', 'wide', 'full'];
const LIGHT_DIRECTION = ['camera_left', 'camera_right', 'front', 'front_left', 'front_right', 'back_left', 'back_right', 'top'];
const LIGHT_QUALITY = ['soft', 'hard'];
const EXPRESSION = ['neutral', 'soft_smile', 'confident', 'laughing', 'shy'];
const TIME_OF_DAY = ['morning', 'midday', 'afternoon', 'golden', 'night'];
const MOTION = new Set(['reel', 'short', 'longform']);

const DEFAULT_MODEL = process.env.STUDIO_PLAN_MODEL || process.env.STUDIO_COPY_MODEL || 'claude-3-5-haiku-latest';

class PlanError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function shotsForKind(kind, frameCount) {
  // A reel is a STORYBOARD of beats, each animated and stitched into one video
  // (assemble's ffmpeg path), not a single clip. frameCount lets the caller ask
  // for a specific number; the defaults keep a reel short and punchy.
  const clampN = (d, lo, hi) => Math.min(Math.max(Number(frameCount) || d, lo), hi);
  if (kind === 'reel' || kind === 'short') return clampN(3, 1, 6);
  if (kind === 'longform') return clampN(5, 2, 8);
  if (kind === 'carousel') return clampN(4, 2, 8);
  return 1;                                                        // post
}

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// The closed-vocabulary "NEVER SENT" guarantee only covers vocabulary fragments.
// The LLM's FREE-TEXT fields (location, wardrobe, action, motion) bypass it, so
// scrub the known AI-tell phrases here deterministically - the reviewer is asked
// to avoid them too, but this is the backstop that does not depend on the model.
const AI_TELLS = /\b(flawless|poreless|blemish[- ]?free|air[- ]?brushed|porcelain skin|perfectly symmetrical|perfect symmetry|glowing skin|dewy[- ]?perfect skin|ultra[- ]?smooth skin|hyper[- ]?realistic|photo[- ]?realistic|8k)\b/gi;
const scrub = (v) => {
  if (!v) return v;
  return String(v)
    .replace(AI_TELLS, '')
    .replace(/\s*,(\s*,)+/g, ',')     // collapse commas left behind
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
};

function extractJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw new PlanError('The planner did not return a usable plan — try rephrasing the idea.', { status: 502 });
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch { throw new PlanError('The planner returned malformed JSON — try again.', { status: 502 }); }
}

const INTENSITY = ['low', 'medium', 'high'];

// The planner's allowed vocabulary is the SAME closed set the renderer and the
// clamp read from prompt_vocabulary - not a frozen copy that silently drifts.
// Loaded per the avatar's version; the module constants above are only a
// fallback if the DB is unreachable, so planning never breaks. Cached per
// version for the process.
const vocabCache = {};
async function loadPlanVocab(avatarId) {
  try {
    const ver = await pool.query(
      `SELECT COALESCE(
         (SELECT vocabulary_version FROM look_profiles  WHERE avatar_id = $1 LIMIT 1),
         (SELECT vocabulary_version FROM style_profiles WHERE avatar_id = $1 LIMIT 1)) AS v`,
      [avatarId]
    );
    const version = (ver.rows[0] && ver.rows[0].v) || 1;
    if (vocabCache[version]) return vocabCache[version];
    const { rows } = await pool.query(
      `SELECT facet, option_key, fragment FROM prompt_vocabulary
        WHERE version = $1 AND active ORDER BY sort_order, option_key`,
      [version]
    );
    const by = {};
    for (const r of rows) (by[r.facet] = by[r.facet] || []).push(r);
    const keys = (facet, fb) => (by[facet] && by[facet].length ? by[facet].map((r) => r.option_key) : fb);
    const firstClause = (frag) => clip(frag, 70).split(',')[0].trim();
    const exprRows = by.expression || [];
    const vocab = {
      framing: keys('framing', FRAMING),
      light_direction: keys('light_direction', LIGHT_DIRECTION),
      light_quality: keys('light_quality', LIGHT_QUALITY),
      expression: keys('expression', EXPRESSION),
      time_of_day: keys('time_of_day', TIME_OF_DAY),
      intensity: INTENSITY,
      expression_gloss: exprRows.length ? exprRows.map((r) => `${r.option_key} (${firstClause(r.fragment)})`).join('; ') : null,
    };
    vocabCache[version] = vocab;
    return vocab;
  } catch (_) {
    return { framing: FRAMING, light_direction: LIGHT_DIRECTION, light_quality: LIGHT_QUALITY, expression: EXPRESSION, time_of_day: TIME_OF_DAY, intensity: INTENSITY, expression_gloss: null };
  }
}

const DIRECTOR_HEAD = [
  'You are a creative director for short-form social video aimed at an Indian audience (Instagram Reels, YouTube Shorts).',
  "Turn the creator's idea into a concrete shoot plan. Be specific and culturally grounded - real Indian settings, festivals, food, wardrobe where relevant.",
  "You control ONLY the setting, wardrobe, mood and camera. You NEVER change the creator's face or identity; that is fixed.",
  'Output ONLY a single JSON object - no prose, no markdown fences.',
];

// The senior editor pass. Same schema and enums (bodyLines is shared), a
// tougher brief: make the plan actually DELIVER the idea before a human sees it.
const REVIEWER_HEAD = [
  "You are a SENIOR creative director reviewing a junior director's shoot plan for short-form Indian social video (Reels/Shorts) before it reaches the human creator.",
  'Return an IMPROVED version of the SAME plan: the same JSON shape and the SAME number of scenes/shots, the same creator (you NEVER change identity or face). Keep what the junior got right; change only what makes the plan better.',
  'Improve, in priority order:',
  '1) FIDELITY - every scene must deliver the idea. If the idea is a how-to or demonstration (for example "three back exercises"), each scene must SHOW a specific, distinct action with the equipment or props, not generic standing and posing. Rewrite the action and motion of any scene that does not serve the idea.',
  '2) FRAMING for the content - a physical demonstration uses full or wide so the action is visible (a close-up cannot show an exercise); a talking explainer uses medium facing the camera; lifestyle may vary. Fix framing that fights the content.',
  '3) COMPLETENESS - no empty or vague scene: every scene needs a concrete location_text, wardrobe_text, a real action, and a real motion. Fill anything the junior left thin.',
  '4) DISTINCTNESS and ARC - a multi-step how-to is DIFFERENT steps, not near-identical poses; a story reel has a clear beginning, middle and end.',
  '5) GROUNDING - real Indian settings, festivals, food, wardrobe where the idea calls for it.',
  '6) NO AI-TELLS - never write phrases that make an image read as AI-generated ("flawless", "poreless", "perfect symmetry", "glowing skin", "porcelain skin", "airbrushed"). If the draft has any, remove them. Describe wardrobe, place and action plainly.',
  'Also add a top-level boolean field "good": true ONLY if the plan now needs no further improvement, false if another pass could still make it better. Keep every other field exactly as the schema below.',
  'Output ONLY the improved JSON object - no prose, no markdown fences, no commentary.',
];

function bodyLines(motion, n, v, castRoster = null) {
  const isConversation = Boolean(motion && castRoster && castRoster.length > 1);
  const castKeys = isConversation ? castRoster.map((m) => m.key) : null;
  const enums = '"framing": "' + v.framing.join('|') + '", "light_direction": "' + v.light_direction.join('|') + '", "light_quality": "' + v.light_quality.join('|') + '", "expression_key": "' + v.expression.join('|') + '", "expression_intensity": "' + v.intensity.join('|') + '"';
  const tail = 'Use ONLY the allowed enum values for framing, light_direction, light_quality, expression_key and expression_intensity. Put anything descriptive into the text fields (location_text, wardrobe_text, action).';
  const exprGuide = v.expression_gloss ? ('Expression options - pick the key whose meaning fits the moment: ' + v.expression_gloss + '.') : null;
  if (motion) {
    return [
      'Shape:',
      '{',
      '  "brief": { "concept": "one vivid sentence", "hook": "3-6 word on-screen hook", "caption_angle": "how the caption should read" },',
      '  "scenes": [ { "time_of_day": "' + v.time_of_day.join('|') + '", "location_text": "where she is plus any equipment or props, one concrete phrase", "wardrobe_text": "what she is wearing, one concrete phrase", ' + enums + (isConversation ? ', "character": "' + castKeys.join('|') + '", "dialogue": "the line THIS scene\'s character speaks, one natural spoken sentence in the idea\'s language (Hindi / Hinglish / English as fits)"' : '') + ', "action": "what the person in this scene is DOING in the photo: the exact posture and how they interact with equipment, props or the subject (for example: gripping the lat-pulldown bar overhead and pulling it toward her chest, side view, back engaged). Not merely standing and posing unless the idea is purely aesthetic", "motion": "how they MOVE in the video: the movement to animate. For a talking scene: they speak to the camera with natural hand gestures" } ]',
      '}',
      'First identify the content TYPE from the idea: a how-to or demonstration (SHOW the action), a talking explainer (she addresses the camera), or a lifestyle or aesthetic piece (mood and looks). Direct each scene like a real person on set: what she is DOING, her posture, and how she interacts with equipment, props or the subject.',
      (isConversation ? 'This is a MULTI-CHARACTER CONVERSATION. Cast: ' + castRoster.map((m) => '"' + m.key + '" = ' + m.name).join(', ') + '. SHOT-REVERSE-SHOT: each scene shows exactly ONE character on screen. Set "character" to that character\'s key and "dialogue" to the line they speak. ALTERNATE characters across scenes so the scenes read as a real back-and-forth with a beginning, middle and end. Every scene MUST set both "character" (one of the cast keys) and "dialogue". Never change any character\'s face or identity.' : null),
      'Choose framing to fit the content: for a physical demonstration use full or wide so the action is visible (a close-up cannot show an exercise); for a talking explainer use medium facing the camera; for lifestyle, vary it.',
      (n === 1
        ? 'Produce exactly 1 scene that carries the idea, with a real action and a real motion.'
        : ('Produce exactly ' + n + ' scenes, each animated and stitched IN ORDER into one reel that MOVES as a mini story with a beginning, middle and end. For a how-to, make each scene a DIFFERENT step or exercise. Each scene has its OWN location_text, wardrobe_text and time_of_day (she can travel between them), plus its own action and motion. Keep the SAME person throughout; wardrobe may change between scenes if the story calls for it.')),
      'Fill both "action" and "motion" for every scene.',
      exprGuide,
      tail,
    ].filter(Boolean);
  }
  return [
    'Shape:',
    '{',
    '  "brief": { "concept": "one vivid sentence", "hook": "3-6 word on-screen hook", "caption_angle": "how the caption should read" },',
    '  "scene": { "time_of_day": "' + v.time_of_day.join('|') + '", "location_text": "where she is, one concrete phrase", "wardrobe_text": "what she is wearing, one concrete phrase" },',
    '  "shots": [ { ' + enums + ', "action": "what she is doing in this shot, one short phrase" } ]',
    '}',
    'Produce exactly ' + n + ' shot' + (n === 1 ? '' : 's') + '. Vary framing across the shots so the set reads well together.',
    exprGuide,
    tail,
  ].filter(Boolean);
}

function buildSystem(kind, motion, n, v, castRoster = null) {
  return DIRECTOR_HEAD.concat(bodyLines(motion, n, v, castRoster)).join('\n');
}

function buildReviewSystem(kind, motion, n, v, castRoster = null) {
  return REVIEWER_HEAD.concat(bodyLines(motion, n, v, castRoster)).join('\n');
}

// Coverage partner framing (T40, Finding 4): pair a wide/establishing shot with a
// close (detail), and a close with a wide (establishing), so a scene reads as
// coverage of ONE moment rather than a new beat.
function coverageFraming(f) {
  const pair = { wide: 'close', full: 'close', medium: 'close', close: 'wide' };
  return pair[f] || 'close';
}

async function plan({ tenantId, avatarId, idea, kind = 'reel', clipSeconds = 5, frameCount, tier = 'free', intent = 'cloud', userId = null, coverage = false, cast = null } = {}, deps = {}) {
  if (!tenantId) throw new PlanError('No tenant on this account', { status: 403 });
  if (!avatarId) throw new PlanError('avatar_id is required');
  if (!idea || !String(idea).trim()) throw new PlanError('Describe the video first.');

  const { rows: [av] } = await pool.query(
    'SELECT name, identity_block, subject_type FROM avatars WHERE id = $1 AND tenant_id = $2',
    [avatarId, tenantId]
  );
  if (!av) throw new PlanError('Avatar not found', { status: 404 });

  const llm = deps.llm || getAnthropic();
  if (!llm) throw new PlanError('Idea planning needs an LLM — set ANTHROPIC_API_KEY in the backend .env (the caption writer needs it too).', { status: 503, code: 'NO_LLM' });

  // ── The cast (multi-character conversations) ─────────────────────────────
  // The lead is always cast key 'lead'. Supporting members (own or catalogue
  // avatars) are validated up front so an unusable co-star fails at plan time,
  // before the user reviews a storyboard they could not generate. No cast → the
  // roster is just the lead and the planner behaves exactly as before.
  const castIn = (Array.isArray(cast) ? cast : [])
    .filter((m) => m && Number.isFinite(Number(m.avatarId)) && String(m.key || '').trim()
      && String(m.key) !== 'lead' && Number(m.avatarId) !== Number(avatarId))
    .map((m) => ({ key: String(m.key), avatarId: Number(m.avatarId) }));
  const castRoster = [{ key: 'lead', name: av.name, subjectType: av.subject_type }];
  if (castIn.length) {
    let resolved;
    try { resolved = await StoryCast.resolve(pool, { tenantId, members: castIn }); }
    catch (e) { throw new PlanError(e.message, { status: e.status || 409, code: e.code || 'BAD_CAST' }); }
    for (const m of resolved.list) castRoster.push({ key: m.key, name: m.name, subjectType: m.subjectType });
  }
  const isConversation = castRoster.length > 1;
  const castKeys = castRoster.map((m) => m.key);

  const nUnits = shotsForKind(kind, frameCount);
  const motion = MOTION.has(kind);
  const vocab = deps.vocab || await loadPlanVocab(avatarId);
  const system = buildSystem(kind, motion, nUnits, vocab, castRoster);
  // Step 2 of the self-learning loop: this creator's best past APPROVED plans,
  // fed in as taste examples. Both the Director and the Reviewer see them (the
  // reviewer's message is built from `user`), so the reviewer can't refine away
  // from the creator's established style. Empty for a new creator -> planner
  // behaves exactly as before.
  const exemplars = deps.exemplars || await PlanFeedback.retrieveExemplars({ tenantId, kind, avatarId, limit: 3 });
  const userLines = [
    'Creator: ' + av.name + (av.identity_block ? ' — ' + clip(av.identity_block, 400) : ''),
    'Format: ' + kind + (motion ? (nUnits === 1 ? ' (1 scene, ' + clipSeconds + 's)' : ' (' + nUnits + ' scenes x ' + clipSeconds + 's, ~' + (nUnits * clipSeconds) + 's total)') : ''),
    'Idea: ' + clip(idea, 800),
  ];
  if (exemplars && exemplars.length) {
    userLines.push(
      '',
      'Past plans THIS creator approved before - their proven taste and structure. Learn the patterns (the kinds of settings and wardrobe, how the actions are written, the framing choices); do NOT copy them, adapt to the idea above:',
      JSON.stringify(exemplars)
    );
  }
  if (isConversation) {
    userLines.push(
      '',
      'Cast (multi-character conversation): ' + castRoster.map((m) => '"' + m.key + '" = ' + m.name).join(', ') + '.',
      'Assign each scene to ONE character (its "character" key) and write that character\'s spoken "dialogue"; alternate speakers so the scenes are a conversation.'
    );
  }
  const user = userLines.join('\n');

  const model = deps.model || await pickModel(llm, process.env.STUDIO_PLAN_MODEL, { prefer: 'sonnet' });
  const resp = await llm.messages.create({ model, max_tokens: 1536, system, messages: [{ role: 'user', content: user }] });
  const textBlock = (resp.content || []).find((b) => b.type === 'text') || (resp.content || [])[0];
  let parsed = extractJson(textBlock && textBlock.text);

  // ── AI reviewer ──────────────────────────────────────────────────────────
  // A second, stronger pass (Sonnet by default) edits the junior director's
  // draft BEFORE the human sees it at Gate 1: fidelity to the idea, framing that
  // fits the content, no empty scenes, distinct steps, and no AI-tell phrases in
  // the free text. It returns the SAME schema and scene count, so its output
  // flows through the exact same sanitiser below. Best-effort by design: any
  // failure (bad JSON, API error, a review that drops the scenes) keeps the
  // director's plan — planning must never block on the reviewer. Skippable with
  // STUDIO_PLAN_REVIEW=off.
  if (process.env.STUDIO_PLAN_REVIEW !== 'off') {
    const rounds = Math.max(1, Math.min(3, Number(process.env.STUDIO_PLAN_REVIEW_ROUNDS) || 3));
    const reviewSystem = buildReviewSystem(kind, motion, nUnits, vocab, castRoster);
    const reviewModel = deps.reviewModel || await pickModel(llm, process.env.STUDIO_REVIEW_MODEL, { prefer: 'opus' });
    const contentKey = (o) => JSON.stringify(motion ? (o && o.scenes) : (o && o.shots));
    for (let round = 0; round < rounds; round += 1) {
      let reviewed;
      try {
        const reviewUser = user + '\n\nJunior director\u2019s draft to improve (return the same shape, same number of ' + (motion ? 'scenes' : 'shots') + ', plus a top-level "good" boolean):\n' + JSON.stringify(parsed);
        const rresp = await llm.messages.create({ model: reviewModel, max_tokens: 2048, system: reviewSystem, messages: [{ role: 'user', content: reviewUser }] });
        const rblock = (rresp.content || []).find((b) => b.type === 'text') || (rresp.content || [])[0];
        reviewed = extractJson(rblock && rblock.text);
      } catch (_) { break; }                                   // keep the best plan so far
      if (!reviewed || !(Array.isArray(reviewed.scenes) || Array.isArray(reviewed.shots))) break;
      if (!reviewed.brief && parsed.brief) reviewed.brief = parsed.brief;   // keep the brief if the editor dropped it
      const converged = contentKey(reviewed) === contentKey(parsed);
      const good = reviewed.good === true || reviewed.good === 'true';
      parsed = reviewed;
      if (good || converged) break;                            // nothing more to gain this round
    }
  }

  let scenesOut = null;
  let scene = null;
  let shots = null;
  if (motion) {
    // Each scene = its own place / outfit / time + one shot; stitched in order.
    const raw = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    scenesOut = raw.slice(0, nUnits).map((sc) => {
      const primary = {
        framing: oneOf(sc && sc.framing, vocab.framing, 'medium'),
        light_direction: oneOf(sc && sc.light_direction, vocab.light_direction, 'camera_left'),
        light_quality: oneOf(sc && sc.light_quality, vocab.light_quality, 'soft'),
        expression_key: oneOf(sc && sc.expression_key, vocab.expression, 'soft_smile'),
        expression_intensity: oneOf(sc && sc.expression_intensity, INTENSITY, 'medium'),
        pose_key: scrub(clip(sc && sc.action, 240)) || null,
        advanced_append: undefined,
      };
      if (isConversation) {
        // Shot-reverse-shot: this scene features ONE cast member speaking one line.
        primary.character = oneOf(sc && sc.character, castKeys, 'lead');
        primary.dialogue = scrub(clip(sc && sc.dialogue, 240)) || null;
      }
      const continuity = {
        location_text: scrub(clip(sc && sc.location_text, 300)),
        wardrobe_text: scrub(clip(sc && sc.wardrobe_text, 300)),
        motion_text: scrub(clip(sc && sc.motion, 300)) || undefined,
      };
      const shots = [primary];
      if (coverage) {
        // Coverage (T40): a second angle of the SAME moment — a complementary
        // framing on the same action, expression and light. A shared per-scene
        // seed (below) makes the two shots render the same instant, reframed;
        // promptStage reads continuity.seed and gives the scene's shots one seed.
        const partner = oneOf(coverageFraming(primary.framing), vocab.framing, primary.framing);
        if (partner !== primary.framing) shots.push({ ...primary, framing: partner, dialogue: null });
        continuity.seed = Math.floor(Math.random() * 2 ** 31);
      }
      return { time_of_day: oneOf(sc && sc.time_of_day, vocab.time_of_day, 'afternoon'), continuity, shots };
    });
    // If the model returned fewer scenes than asked, don't pad with a BLANK scene
    // (that renders her in a void) - clone the last real scene so the reel simply
    // holds on a real setting. Only fall back to a bare default if there are none.
    while (scenesOut.length < nUnits) {
      const seed = scenesOut[scenesOut.length - 1];
      scenesOut.push(seed
        ? JSON.parse(JSON.stringify(seed))
        : { time_of_day: 'afternoon', continuity: { location_text: '', wardrobe_text: '' },
            shots: [{ framing: 'medium', light_direction: 'camera_left', light_quality: 'soft', expression_key: 'soft_smile', expression_intensity: 'medium' }] });
    }
  } else {
    shots = (Array.isArray(parsed.shots) ? parsed.shots : []).slice(0, nUnits).map((s) => ({
      framing: oneOf(s && s.framing, vocab.framing, 'medium'),
      light_direction: oneOf(s && s.light_direction, vocab.light_direction, 'camera_left'),
      light_quality: oneOf(s && s.light_quality, vocab.light_quality, 'soft'),
      expression_key: oneOf(s && s.expression_key, vocab.expression, 'soft_smile'),
      expression_intensity: oneOf(s && s.expression_intensity, INTENSITY, 'medium'),
      pose_key: scrub(clip(s && s.action, 240)) || null,
      advanced_append: undefined,
    }));
    while (shots.length < nUnits) {
      const seed = shots[shots.length - 1];
      shots.push(seed
        ? JSON.parse(JSON.stringify(seed))
        : { framing: 'medium', light_direction: 'camera_left', light_quality: 'soft', expression_key: 'soft_smile', expression_intensity: 'medium' });
    }
    scene = {
      time_of_day: oneOf(parsed.scene && parsed.scene.time_of_day, vocab.time_of_day, 'afternoon'),
      continuity: {
        location_text: scrub(clip(parsed.scene && parsed.scene.location_text, 300)),
        wardrobe_text: scrub(clip(parsed.scene && parsed.scene.wardrobe_text, 300)),
      },
    };
  }

  const concept = clip(parsed.brief && parsed.brief.concept, 500) || clip(idea, 500);
  const brief = {
    title: (clip(parsed.brief && parsed.brief.hook, 60) || concept).slice(0, 120),
    concept,
    hook: clip(parsed.brief && parsed.brief.hook, 120),
    caption_angle: clip(parsed.brief && parsed.brief.caption_angle, 200),
    trend_source: 'idea',
  };

  // Planning is SIDE-EFFECT-FREE: it returns the storyboard for the user to
  // review and edit. Nothing is rendered and no credit is spent until they
  // approve and call generate (POST /shoots/generate). Scenes are unified so
  // motion and non-motion review the same shape.
  const scenes = motion
    ? scenesOut
    : [{ time_of_day: scene.time_of_day, continuity: scene.continuity, shots }];
  // The allowed vocabulary the plan was built against, so the storyboard editor
  // offers exactly the same options (not a frozen frontend subset).
  const options = {
    framing: vocab.framing, light_direction: vocab.light_direction,
    light_quality: vocab.light_quality, expression: vocab.expression,
    time_of_day: vocab.time_of_day, intensity: vocab.intensity,
  };
  return { brief, kind, clipSeconds, scenes, options, cast: castIn };
}

async function optionsForAvatar(avatarId) {
  const v = await loadPlanVocab(avatarId);
  return {
    framing: v.framing, light_direction: v.light_direction, light_quality: v.light_quality,
    expression: v.expression, time_of_day: v.time_of_day, intensity: v.intensity,
  };
}

module.exports = { plan, optionsForAvatar, buildSystem, PlanError, FRAMING, LIGHT_DIRECTION, LIGHT_QUALITY, EXPRESSION, TIME_OF_DAY };
