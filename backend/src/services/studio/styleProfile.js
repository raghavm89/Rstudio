'use strict';

const pool = require('../../config/db');
const { assembleCharacterPrompt, indexVocabulary, WorkflowError } =
  require('./comfyui/buildWorkflow');

/**
 * How a CHARACTER should look.
 *
 * The character's answer to `lookProfile.js`. A person's look is camera, lens,
 * grain, skin — human photography. A personified fruit or a mascot has none of
 * those; its "look" is an illustration STYLE: render style, palette, line
 * weight, shading, background. Same versioned `prompt_vocabulary` mechanism, so
 * improving a fragment improves every tenant with no action from them; same
 * freeze-once-calibrated rule, for the same reason (the QC baseline was measured
 * on frames rendered under THESE settings).
 *
 * See claude/character-line-scope.md (Phase C, CA7).
 */

/**
 * Phrases with no vocabulary row, shown struck through on the style screen.
 * The character analogue of the human look's anti-AI-skin list: the tells that
 * make an illustration look cheap or machine-made, which no picker choice emits.
 */
const NEVER_SENT = [
  'generic clip art',
  'low effort',
  'ms paint',
  'stock illustration',
  'watermark',
  'default render',
];

/** The shot the preview is assembled against — representative, not special. */
const PREVIEW_SHOT = {
  framing: 'medium',
  light_direction: 'camera_left',
  light_quality: 'soft',
  expression_key: 'neutral',
  pose_key: null,
};

const LABELS = {
  render_style: {
    flat_2d:     'Flat 2D',
    soft_3d:     'Soft 3D',
    watercolour: 'Watercolour',
    claymation:  'Claymation',
    cel_shaded:  'Cel-shaded',
  },
  palette:     { warm: 'Warm', cool: 'Cool', pastel: 'Pastel', vivid: 'Vivid', muted: 'Muted' },
  line_weight: { none: 'None', fine: 'Fine', bold: 'Bold' },
  shading:     { flat: 'Flat', soft: 'Soft', dramatic: 'Dramatic' },
  background:  { plain: 'Plain', soft_scene: 'Soft scene', patterned: 'Patterned' },
};

const FACET_META = {
  render_style: { label: 'Render style',
                  note: 'The single biggest choice — it decides whether this reads as a cartoon, a 3D toy, or a painting.' },
  palette:      { label: 'Palette' },
  line_weight:  { label: 'Outline' },
  shading:      { label: 'Shading' },
  background:   { label: 'Background' },
};

const FACETS = ['render_style', 'palette', 'line_weight', 'shading', 'background'];

class StyleProfileError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'StyleProfileError';
    this.status = status;
    this.code = code;
  }
}

const StyleProfile = {
  NEVER_SENT,
  PREVIEW_SHOT,
  FACETS,
  StyleProfileError,

  /** Everything the style screen needs in one call. */
  async describe(tenantId, avatarId) {
    const { rows } = await pool.query(
      `SELECT a.id, a.slug, a.name, a.identity_block, a.avoid_block, a.subject_type,
              sp.render_style, sp.palette, sp.line_weight, sp.shading, sp.background,
              sp.vocabulary_version,
              l.id AS lora_id, l.trigger_token
         FROM avatars a
         LEFT JOIN style_profiles sp ON sp.avatar_id = a.id
         LEFT JOIN avatar_loras   l  ON l.avatar_id = a.id AND l.active
        WHERE a.id = $1 AND a.tenant_id = $2`,
      [avatarId, tenantId]
    );
    const row = rows[0];
    if (!row) throw new StyleProfileError('Avatar not found', { status: 404 });
    if (row.subject_type !== 'character') {
      throw new StyleProfileError('This avatar is a person — it has a look profile, not a style profile.',
        { status: 409, code: 'NOT_A_CHARACTER' });
    }

    const version = row.vocabulary_version || 1;
    const { rows: vocabulary } = await pool.query(
      `SELECT facet, option_key, fragment FROM prompt_vocabulary
        WHERE version = $1 AND active ORDER BY facet, sort_order NULLS LAST, option_key`,
      [version]
    );

    const options = {};
    for (const v of vocabulary) {
      if (!FACETS.includes(v.facet)) continue;
      (options[v.facet] ||= []).push({
        key: v.option_key,
        label: LABELS[v.facet]?.[v.option_key]
          || v.option_key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        fragment: v.fragment || null,
      });
    }

    const profile = row.render_style
      ? Object.fromEntries(FACETS.map((f) => [f, row[f]]))
      : null;

    const frozen = await this.isFrozen(avatarId);

    return {
      avatar: { id: row.id, slug: row.slug, name: row.name },
      profile,
      options,
      facets: FACETS.map((f) => ({ key: f, ...FACET_META[f] })),
      never_sent: NEVER_SENT,
      frozen,
      preview: profile ? this.preview({ row, profile, vocabulary }) : null,
    };
  },

  /** Assemble the prompt this style would produce (preview of text, not a render). */
  preview({ row, profile, vocabulary }) {
    const trained = Boolean(row.lora_id);
    try {
      const prompt = assembleCharacterPrompt({
        avatar: { slug: row.slug, identity_block: row.identity_block, avoid_block: row.avoid_block },
        lora: { trigger_token: row.trigger_token || 'TRIGGER', file_path: 'x', base_checkpoint: null },
        styleProfile: profile,
        shot: PREVIEW_SHOT,
        scene: { time_of_day: 'afternoon' },
        vocabulary,
        locationText: '',
        wardrobeText: '',
      });
      return { prompt, trained, shot: PREVIEW_SHOT };
    } catch (err) {
      if (err instanceof WorkflowError) return { prompt: null, error: err.message, trained };
      throw err;
    }
  },

  /**
   * Is the style still editable? Same rule as the look profile: it freezes once
   * QC baselines exist, because those were calibrated on frames rendered under
   * THESE settings, and changing them would judge every future frame against a
   * character drawn a different way.
   */
  async isFrozen(avatarId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM expression_baselines b
         JOIN avatar_loras l ON l.id = b.lora_id
        WHERE l.avatar_id = $1`,
      [avatarId]
    );
    return rows[0].n > 0;
  },

  /** Save. Validates every value against the vocabulary before it lands. */
  async update(tenantId, avatarId, changes) {
    const { rows: owned } = await pool.query(
      `SELECT a.id, a.subject_type, sp.vocabulary_version
         FROM avatars a LEFT JOIN style_profiles sp ON sp.avatar_id = a.id
        WHERE a.id = $1 AND a.tenant_id = $2`,
      [avatarId, tenantId]
    );
    if (!owned[0]) throw new StyleProfileError('Avatar not found', { status: 404 });
    if (owned[0].subject_type !== 'character') {
      throw new StyleProfileError('This avatar is a person — edit its look profile instead.',
        { status: 409, code: 'NOT_A_CHARACTER' });
    }

    if (await this.isFrozen(avatarId)) {
      throw new StyleProfileError(
        'This character\'s style is locked. The likeness check was calibrated against frames drawn with ' +
        'these settings — changing them now would judge every future frame against a character made a ' +
        'different way. Recalibrate first if you really want to change it.',
        { status: 409, code: 'STYLE_FROZEN' }
      );
    }

    const version = owned[0].vocabulary_version || 1;
    const { rows: vocabulary } = await pool.query(
      'SELECT facet, option_key, fragment FROM prompt_vocabulary WHERE version = $1 AND active',
      [version]
    );
    const vocab = indexVocabulary(vocabulary);

    const next = {};
    for (const facet of FACETS) {
      if (changes[facet] === undefined) continue;
      if (!vocab[facet] || vocab[facet][changes[facet]] === undefined) {
        throw new StyleProfileError(
          `"${changes[facet]}" is not an option for ${facet}.`,
          { status: 400, code: 'UNKNOWN_OPTION' }
        );
      }
      next[facet] = changes[facet];
    }
    if (!Object.keys(next).length) throw new StyleProfileError('Nothing to change.');

    const cols = Object.keys(next);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(
      `INSERT INTO style_profiles (avatar_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (avatar_id) DO UPDATE SET ${sets}, updated_at = NOW()`,
      [avatarId, ...cols.map((c) => next[c])]
    );

    return this.describe(tenantId, avatarId);
  },
};

module.exports = StyleProfile;
module.exports.LABELS = LABELS;
module.exports.FACET_META = FACET_META;
