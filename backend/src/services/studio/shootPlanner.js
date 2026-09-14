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

function extractJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw new PlanError('The planner did not return a usable plan — try rephrasing the idea.', { status: 502 });
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch { throw new PlanError('The planner returned malformed JSON — try again.', { status: 502 }); }
}

function buildSystem(kind, motion, n) {
  const head = [
    'You are a creative director for short-form social video aimed at an Indian audience (Instagram Reels, YouTube Shorts).',
    "Turn the creator's idea into a concrete shoot plan. Be specific and culturally grounded - real Indian settings, festivals, food, wardrobe where relevant.",
    "You control ONLY the setting, wardrobe, mood and camera. You NEVER change the creator's face or identity; that is fixed.",
    'Output ONLY a single JSON object - no prose, no markdown fences.',
  ];
  const enums = '"framing": "' + FRAMING.join('|') + '", "light_direction": "' + LIGHT_DIRECTION.join('|') + '", "light_quality": "' + LIGHT_QUALITY.join('|') + '", "expression_key": "' + EXPRESSION.join('|') + '"';
  const tail = 'Use ONLY the allowed enum values for framing, light_direction, light_quality and expression_key. Put anything descriptive into the text fields (location_text, wardrobe_text, action).';
  if (motion) {
    return head.concat([
      'Shape:',
      '{',
      '  "brief": { "concept": "one vivid sentence", "hook": "3-6 word on-screen hook", "caption_angle": "how the caption should read" },',
      '  "scenes": [ { "time_of_day": "' + TIME_OF_DAY.join('|') + '", "location_text": "where she is plus any equipment or props, one concrete phrase", "wardrobe_text": "what she is wearing, one concrete phrase", ' + enums + ', "action": "what she is DOING in the photo: the exact posture and how she interacts with equipment, props or the subject (for example: gripping the lat-pulldown bar overhead and pulling it toward her chest, side view, back engaged). Not merely standing and posing unless the idea is purely aesthetic", "motion": "how she MOVES in the video: the movement to animate (for example: she pulls the bar down to her chest, then lets it rise back up). For a talking scene: she speaks to the camera with natural hand gestures" } ]',
      '}',
      'First identify the content TYPE from the idea: a how-to or demonstration (SHOW the action), a talking explainer (she addresses the camera), or a lifestyle or aesthetic piece (mood and looks). Direct each scene like a real person on set: what she is DOING, her posture, and how she interacts with equipment, props or the subject.',
      'Choose framing to fit the content: for a physical demonstration use full or wide so the action is visible (a close-up cannot show an exercise); for a talking explainer use medium facing the camera; for lifestyle, vary it.',
      (n === 1
        ? 'Produce exactly 1 scene that carries the idea, with a real action and a real motion.'
        : ('Produce exactly ' + n + ' scenes, each animated and stitched IN ORDER into one reel that MOVES as a mini story with a beginning, middle and end. For a how-to, make each scene a DIFFERENT step or exercise. Each scene has its OWN location_text, wardrobe_text and time_of_day (she can travel between them), plus its own action and motion. Keep the SAME person throughout; wardrobe may change between scenes if the story calls for it.')),
      'Fill both "action" and "motion" for every scene.',
      tail,
    ]).join('\n');
  }
  return head.concat([
    'Shape:',
    '{',
    '  "brief": { "concept": "one vivid sentence", "hook": "3-6 word on-screen hook", "caption_angle": "how the caption should read" },',
    '  "scene": { "time_of_day": "' + TIME_OF_DAY.join('|') + '", "location_text": "where she is, one concrete phrase", "wardrobe_text": "what she is wearing, one concrete phrase" },',
    '  "shots": [ { ' + enums + ', "action": "what she is doing in this shot, one short phrase" } ]',
    '}',
    'Produce exactly ' + n + ' shot' + (n === 1 ? '' : 's') + '. Vary framing across the shots so the set reads well together.',
    tail,
  ]).join('\n');
}

async function plan({ tenantId, avatarId, idea, kind = 'reel', clipSeconds = 5, frameCount, tier = 'free', intent = 'cloud', userId = null } = {}, deps = {}) {
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

  const nUnits = shotsForKind(kind, frameCount);
  const motion = MOTION.has(kind);
  const system = buildSystem(kind, motion, nUnits);
  const user = [
    'Creator: ' + av.name + (av.identity_block ? ' — ' + clip(av.identity_block, 400) : ''),
    'Format: ' + kind + (motion ? (nUnits === 1 ? ' (1 scene, ' + clipSeconds + 's)' : ' (' + nUnits + ' scenes x ' + clipSeconds + 's, ~' + (nUnits * clipSeconds) + 's total)') : ''),
    'Idea: ' + clip(idea, 800),
  ].join('\n');

  const model = deps.model || await pickModel(llm, process.env.STUDIO_PLAN_MODEL || process.env.STUDIO_COPY_MODEL);
  const resp = await llm.messages.create({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] });
  const textBlock = (resp.content || []).find((b) => b.type === 'text') || (resp.content || [])[0];
  const parsed = extractJson(textBlock && textBlock.text);

  let scenesOut = null;
  let scene = null;
  let shots = null;
  if (motion) {
    // Each scene = its own place / outfit / time + one shot; stitched in order.
    const raw = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    scenesOut = raw.slice(0, nUnits).map((sc) => ({
      time_of_day: oneOf(sc && sc.time_of_day, TIME_OF_DAY, 'afternoon'),
      continuity: {
        location_text: clip(sc && sc.location_text, 300),
        wardrobe_text: clip(sc && sc.wardrobe_text, 300),
        motion_text: clip(sc && sc.motion, 300) || undefined,
      },
      shots: [{
        framing: oneOf(sc && sc.framing, FRAMING, 'medium'),
        light_direction: oneOf(sc && sc.light_direction, LIGHT_DIRECTION, 'camera_left'),
        light_quality: oneOf(sc && sc.light_quality, LIGHT_QUALITY, 'soft'),
        expression_key: oneOf(sc && sc.expression_key, EXPRESSION, 'soft_smile'),
        expression_intensity: 'medium',
        pose_key: clip(sc && sc.action, 240) || null,
        advanced_append: undefined,
      }],
    }));
    while (scenesOut.length < nUnits) {
      scenesOut.push({ time_of_day: 'afternoon', continuity: { location_text: '', wardrobe_text: '' },
        shots: [{ framing: 'medium', light_direction: 'camera_left', light_quality: 'soft', expression_key: 'soft_smile', expression_intensity: 'medium' }] });
    }
  } else {
    shots = (Array.isArray(parsed.shots) ? parsed.shots : []).slice(0, nUnits).map((s) => ({
      framing: oneOf(s && s.framing, FRAMING, 'medium'),
      light_direction: oneOf(s && s.light_direction, LIGHT_DIRECTION, 'camera_left'),
      light_quality: oneOf(s && s.light_quality, LIGHT_QUALITY, 'soft'),
      expression_key: oneOf(s && s.expression_key, EXPRESSION, 'soft_smile'),
      expression_intensity: 'medium',
      pose_key: clip(s && s.action, 240) || null,
      advanced_append: undefined,
    }));
    while (shots.length < nUnits) {
      shots.push({ framing: 'medium', light_direction: 'camera_left', light_quality: 'soft', expression_key: 'soft_smile', expression_intensity: 'medium' });
    }
    scene = {
      time_of_day: oneOf(parsed.scene && parsed.scene.time_of_day, TIME_OF_DAY, 'afternoon'),
      continuity: {
        location_text: clip(parsed.scene && parsed.scene.location_text, 300),
        wardrobe_text: clip(parsed.scene && parsed.scene.wardrobe_text, 300),
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
  return { brief, kind, clipSeconds, scenes };
}

module.exports = { plan, PlanError, FRAMING, LIGHT_DIRECTION, LIGHT_QUALITY, EXPRESSION, TIME_OF_DAY };
