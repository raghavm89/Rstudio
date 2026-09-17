'use strict';

/**
 * Format extraction (T31, offering-frozen-spec §2 #2).
 *
 * A creator DESCRIBES a reel/short/post format they like; we extract its reusable
 * STRUCTURE — the beats, framing, pacing, hook and caption angle — as a generic,
 * avatar-agnostic template that plugs into the content-templates system and
 * renders through the normal pipeline when applied to the creator's own avatar.
 *
 * SAFE BY DESIGN: structure only. It works from the creator's own text
 * description — it never fetches, downloads or reproduces the original's footage,
 * audio, script, brand or any copyrighted content (that constraint is in the
 * system prompt, and there is no network fetch here at all).
 */

const { pickModel } = require('./anthropicModel');

class ExtractError extends Error {
  constructor(message, { status = 500, code = null } = {}) {
    super(message); this.name = 'ExtractError'; this.status = status; this.code = code;
  }
}

// Enum domains for the recipe. A superset of the render vocabulary — the real,
// per-avatar clamp happens again in createShoot when the template is applied, so
// this only has to keep the LLM inside sane values.
const VOCAB = {
  framing: ['close', 'medium', 'full', 'wide'],
  light_direction: ['camera_left', 'camera_right', 'window', 'backlit', 'top', 'front', 'side', 'rim'],
  light_quality: ['soft', 'hard'],
  expression: ['neutral', 'soft_smile', 'laughing', 'confident', 'surprised', 'thoughtful', 'playful', 'serious', 'warm', 'candid', 'determined'],
  time_of_day: ['morning', 'midday', 'afternoon', 'golden', 'night'],
  intensity: ['light', 'medium', 'strong'],
};

const MOTION_KINDS = new Set(['reel', 'short', 'longform']);
const CATEGORY_FOR_KIND = { reel: 'viral_video', short: 'viral_video', longform: 'viral_video', post: 'viral_stills', carousel: 'viral_stills' };

const clip = (v, n) => (v == null ? '' : String(v).trim().slice(0, n));
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: key });
}

/** First balanced JSON object in a string. Tolerant of prose around it. */
function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function buildSystem(kind, motion) {
  const enums =
    'framing: ' + VOCAB.framing.join('|') + '; expression_key: ' + VOCAB.expression.join('|') +
    '; light_direction: ' + VOCAB.light_direction.join('|') + '; light_quality: soft|hard; time_of_day: ' + VOCAB.time_of_day.join('|') +
    '; expression_intensity: ' + VOCAB.intensity.join('|');
  return [
    'You are a short-video FORMAT analyst for an AI creator studio. A creator describes a ' + kind + ' format they admire. Extract its reusable STRUCTURE so ANY creator can shoot it with their OWN avatar.',
    'Rules:',
    '- Extract the FORMAT ONLY: the beats/shots, their framing and pacing, the hook style, the on-screen-text pattern and the caption angle.',
    '- Do NOT reproduce the original’s exact words, script, footage, music, brand names, logos, or any copyrighted or trademarked content. Describe the PATTERN, generically.',
    '- Keep it avatar-agnostic: no specific real person; refer to "she" / "the creator" only. No hashtags, no @handles, no song titles.',
    '- Use ONLY these enum values (put any descriptive detail in the text fields): ' + enums + '.',
    'Return ONLY a JSON object, no prose:',
    '{ "title": "short name for this format (2-4 words)",',
    '  "concept": "one sentence describing the format generically",',
    '  "hook": "the opening hook STYLE, generic (not the original words)",',
    '  "caption_angle": "the caption / voice angle",',
    '  "time_of_day": "one enum",',
    '  "location_text": "a generic setting phrase",',
    '  "wardrobe_text": "a generic wardrobe phrase",',
    (motion ? '  "motion_text": "how she MOVES across the reel, generic",' : ''),
    '  "shots": [ { ' + (motion ? '' : '') + '"framing": "enum", "expression_key": "enum", "light_direction": "enum", "light_quality": "soft|hard", "expression_intensity": "enum", "action": "what she does in this beat, generic, one short phrase" } ] }',
    'Produce ' + (motion ? '2-6 shots (beats)' : '3-6 shots') + '. Vary framing so the set reads well.',
  ].filter(Boolean).join('\n');
}

/**
 * @returns {Promise<object>} a template-shaped object { name, category, kind,
 *   clip_seconds, frame_count, recipe:{brief, scene, shots} } — NOT saved. The
 *   caller reviews it and POSTs /templates to persist it.
 */
async function extract({ description, kind = 'reel', clipSeconds = 5 } = {}, deps = {}) {
  if (!description || !String(description).trim()) {
    throw new ExtractError('Describe the format you want to extract', { status: 400, code: 'NO_DESCRIPTION' });
  }
  const llm = deps.llm || getAnthropic();
  if (!llm) throw new ExtractError('Format extraction needs an LLM — set ANTHROPIC_API_KEY in the backend .env', { status: 503, code: 'NO_LLM' });

  const motion = MOTION_KINDS.has(kind);
  const system = buildSystem(kind, motion);
  const model = deps.model || await pickModel(llm, process.env.STUDIO_PLAN_MODEL, { prefer: 'sonnet' });

  const resp = await llm.messages.create({
    model, max_tokens: 1200, system,
    messages: [{ role: 'user', content: 'Describe-and-extract this ' + kind + ' FORMAT into a reusable structure. Here is the creator’s description:\n\n' + String(description).slice(0, 4000) }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  const parsed = parseJson(text);
  if (!parsed) throw new ExtractError('Could not read a structure back from the model — try describing the format more concretely', { status: 422, code: 'NO_STRUCTURE' });

  const raw = Array.isArray(parsed.shots) ? parsed.shots : [];
  const shots = raw.slice(0, 6).map((s) => ({
    framing: oneOf(s && s.framing, VOCAB.framing, 'medium'),
    light_direction: oneOf(s && s.light_direction, VOCAB.light_direction, 'camera_left'),
    light_quality: oneOf(s && s.light_quality, VOCAB.light_quality, 'soft'),
    expression_key: oneOf(s && s.expression_key, VOCAB.expression, 'soft_smile'),
    expression_intensity: oneOf(s && s.expression_intensity, VOCAB.intensity, 'medium'),
    pose_key: clip(s && (s.action || s.pose_key), 240) || null,
  }));
  if (!shots.length) throw new ExtractError('That description did not yield any shots — add more about what happens on screen', { status: 422, code: 'EMPTY' });

  const recipe = {
    brief: {
      concept: clip(parsed.concept || (parsed.brief && parsed.brief.concept), 400) || 'Extracted format',
      hook: clip(parsed.hook, 160) || undefined,
      caption_angle: clip(parsed.caption_angle || parsed.caption_pattern, 240) || undefined,
      slot_type: 'extracted',
      trend_source: 'format_extract',
    },
    scene: {
      time_of_day: oneOf(parsed.time_of_day, VOCAB.time_of_day, 'afternoon'),
      continuity: {
        location_text: clip(parsed.location_text, 300),
        wardrobe_text: clip(parsed.wardrobe_text, 300),
        ...(motion ? { motion_text: clip(parsed.motion_text, 300) || undefined } : {}),
      },
    },
    shots,
  };

  return {
    name: clip(parsed.title || parsed.name, 80) || 'Extracted format',
    category: CATEGORY_FOR_KIND[kind] || 'viral_video',
    kind,
    clip_seconds: Number(clipSeconds) || 5,
    frame_count: shots.length,
    recipe,
  };
}

module.exports = { extract, ExtractError, VOCAB };
