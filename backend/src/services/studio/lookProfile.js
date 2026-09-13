'use strict';

const pool = require('../../config/db');
const { assemblePrompt, indexVocabulary, WorkflowError } =
  require('./comfyui/buildWorkflow');

/**
 * How her photos should feel.
 *
 * Seven picker choices — camera, lens, colour, grain, skin, and two toggles —
 * that are concatenated into every prompt this avatar ever produces. Not free
 * text, deliberately: the mapping from choice to prompt fragment lives in the
 * versioned `prompt_vocabulary` table, so improving a fragment improves every
 * tenant's output with no action from them. A free-text box gives that away
 * permanently.
 *
 * The screen this backs shows the REAL assembled prompt, and underneath it the
 * phrases that are never sent. That second list is the point. Every one of these
 * is a phrase that makes an image look like an AI image — and none of them
 * exists anywhere in the vocabulary, so no combination of picker choices can
 * emit them. Showing the absence is how a buyer can tell there is a considered
 * machine here rather than a prompt box with a nice font.
 */

/**
 * Phrases with no vocabulary row, shown struck through on the look screen.
 *
 * Kept here rather than derived, because their absence is a design decision and
 * a decision needs somewhere to live. `prompt-builder` has a test that fails if
 * any of these ever appears in a fragment, so this list and the vocabulary
 * cannot silently drift apart.
 */
const NEVER_SENT = [
  'flawless skin',
  'porcelain complexion',
  'perfect symmetry',
  'airbrushed',
  'blemish-free',
  'poreless',
  'doll-like',
  'plastic skin',
];

/** The shot the preview is assembled against — representative, not special. */
const PREVIEW_SHOT = {
  framing: 'medium',
  light_direction: 'camera_left',
  light_quality: 'soft',
  expression_key: 'neutral',
  pose_key: null,
};

/**
 * Human labels, and the note that explains each control.
 *
 * `prompt_vocabulary` stores FRAGMENTS — the prompt text a choice emits. Those
 * are not UI labels, and handing them to a screen produces two problems: they
 * read as engineering ("85mm f/1.4 portrait lens, shallow depth of field…"), and
 * a legitimately empty fragment renders as nothing at all. `grain: none` emits
 * no text by design, which is correct and would have shown as a blank option.
 *
 * The notes exist because of a rule in the design system: a constraint should
 * explain itself where the choice is made, not in documentation nobody opens.
 */
const LABELS = {
  base_look: {
    editorial:     'Editorial',
    warm_film:     'Warm film',
    clean_digital: 'Clean digital',
    grainy_street: 'Grainy street',
  },
  lens: {
    portrait_85:      '85mm portrait',
    natural_50:       '50mm natural',
    environmental_35: '35mm environmental',
  },
  colour: { warm: 'Warm', neutral: 'Neutral', cool: 'Cool', contrast: 'High contrast' },
  grain:  { none: 'None', fine: 'Fine', visible: 'Visible' },
  skin:   { subtle: 'Subtle', natural: 'Natural', textured: 'Textured' },
};

const FACET_META = {
  base_look: { label: 'The overall look' },
  lens:      { label: 'Lens',
               note: "There is nothing wider than 35mm on purpose — wider lenses bend a face at the edges of frame." },
  colour:    { label: 'Colour' },
  grain:     { label: 'Grain' },
  skin:      { label: 'Skin',
               note: 'Visible pores are the strongest single signal separating a photograph from an AI image.' },
};

const TOGGLE_META = {
  natural_asymmetry: { label: 'Natural asymmetry',
                       note: 'Nobody\'s face is symmetrical. Perfect symmetry is the tell.' },
  hair_detail:       { label: 'Hair detail',
                       note: 'Individual strands at the hairline, rather than a helmet.' },
};

const FACETS = ['base_look', 'lens', 'colour', 'grain', 'skin'];
const TOGGLES = ['natural_asymmetry', 'hair_detail'];

class LookProfileError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'LookProfileError';
    this.status = status;
    this.code = code;
  }
}

const LookProfile = {
  NEVER_SENT,
  PREVIEW_SHOT,
  FACETS,
  TOGGLES,
  LookProfileError,

  /**
   * Everything the screen needs in one call: the current selection, every option
   * the vocabulary defines, the assembled preview, and whether it is still
   * editable.
   */
  async describe(tenantId, avatarId) {
    const { rows } = await pool.query(
      `SELECT a.id, a.slug, a.name, a.identity_block, a.avoid_block,
              lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
              lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version,
              l.id AS lora_id, l.trigger_token
         FROM avatars a
         LEFT JOIN look_profiles lp ON lp.avatar_id = a.id
         LEFT JOIN avatar_loras  l  ON l.avatar_id = a.id AND l.active
        WHERE a.id = $1 AND a.tenant_id = $2`,
      [avatarId, tenantId]
    );
    const row = rows[0];
    if (!row) throw new LookProfileError('Avatar not found', { status: 404 });

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
        // Falls back to a humanised key rather than the fragment, so a
        // vocabulary row added without a label here still reads as English.
        label: LABELS[v.facet]?.[v.option_key]
          || v.option_key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        fragment: v.fragment || null,
      });
    }

    const profile = row.base_look
      ? Object.fromEntries([...FACETS, ...TOGGLES].map((f) => [f, row[f]]))
      : null;

    const frozen = await this.isFrozen(avatarId);

    return {
      avatar: { id: row.id, slug: row.slug, name: row.name },
      profile,
      options,
      facets: FACETS.map((f) => ({ key: f, ...FACET_META[f] })),
      toggles: TOGGLES.map((t) => ({ key: t, ...TOGGLE_META[t] })),
      never_sent: NEVER_SENT,
      avoid_block: row.avoid_block,
      frozen,
      preview: profile ? this.preview({ row, profile, vocabulary }) : null,
    };
  },

  /**
   * Assemble the prompt this look would produce.
   *
   * `assemblePrompt` refuses without a LoRA — correctly, since the product must
   * never render a faceless persona. But this is a preview of text, not a
   * render, and the look has to be choosable BEFORE training. So a placeholder
   * trigger stands in, and it is labelled as one on screen rather than quietly
   * implying a model exists.
   */
  preview({ row, profile, vocabulary }) {
    const trained = Boolean(row.lora_id);
    try {
      const prompt = assemblePrompt({
        avatar: { slug: row.slug, identity_block: row.identity_block, avoid_block: row.avoid_block },
        lora: { trigger_token: row.trigger_token || 'TRIGGER', file_path: 'x', base_checkpoint: null },
        lookProfile: profile,
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
   * Is the look still editable?
   *
   * It stops being editable once QC baselines exist. The gate measures a frame's
   * similarity against an expectation calibrated on faces generated under THESE
   * settings — change the lens or the skin texture afterwards and every
   * subsequent frame is judged against a face rendered a different way. The
   * numbers would drift without anything reporting an error, which is the worst
   * kind of wrong.
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
      'SELECT id, vocabulary_version FROM avatars a LEFT JOIN look_profiles lp ON lp.avatar_id = a.id WHERE a.id = $1 AND a.tenant_id = $2',
      [avatarId, tenantId]
    );
    if (!owned[0]) throw new LookProfileError('Avatar not found', { status: 404 });

    if (await this.isFrozen(avatarId)) {
      throw new LookProfileError(
        'Her look is locked. The likeness check was calibrated against photos taken with these settings — ' +
        'changing them now would judge every future photo against a face made a different way. ' +
        'Recalibrate first if you really want to change it.',
        { status: 409, code: 'LOOK_FROZEN' }
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
        // A value the vocabulary does not define would otherwise surface much
        // later as a refused prompt assembly, mid-shoot.
        throw new LookProfileError(
          `"${changes[facet]}" is not an option for ${facet}.`,
          { status: 400, code: 'UNKNOWN_OPTION' }
        );
      }
      next[facet] = changes[facet];
    }
    for (const t of TOGGLES) {
      if (changes[t] !== undefined) next[t] = Boolean(changes[t]);
    }
    if (!Object.keys(next).length) throw new LookProfileError('Nothing to change.');

    const cols = Object.keys(next);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(
      `INSERT INTO look_profiles (avatar_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (avatar_id) DO UPDATE SET ${sets}, updated_at = NOW()`,
      [avatarId, ...cols.map((c) => next[c])]
    );

    return this.describe(tenantId, avatarId);
  },
};

module.exports = LookProfile;
module.exports.LABELS = LABELS;
module.exports.FACET_META = FACET_META;
