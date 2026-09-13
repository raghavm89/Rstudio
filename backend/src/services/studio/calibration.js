'use strict';

const pool         = require('../../config/db');
const FaceQc       = require('./faceQc');
const LoraTraining = require('./loraTraining');
const { expressiblePresets } = require('./comfyui/buildWorkflow');

/**
 * Calibrating the QC gate.
 *
 * A crying face legitimately scores lower against the reference than a neutral
 * one — the geometry moved. So the gate cannot be one number; it is a per
 * (avatar, LoRA, expression, framing) expectation, measured once, right after
 * training and before the model is allowed to render anything that publishes.
 *
 * This module runs that measurement: for each preset, generate a handful of
 * frames, embed them, compare each against the seed-set mean, and hand the
 * resulting spread to `FaceQc.calibrate` which turns it into an expectation and
 * a tolerance.
 *
 * The part worth stating plainly: **calibration samples are not quality-checked
 * first**. It is tempting to drop the worst frames before measuring, and it is
 * exactly wrong — dropping the low scorers makes the sample tighter than
 * reality, which makes the tolerance smaller, which makes the gate reject
 * normal output forever after. The spread IS the measurement. A frame is
 * excluded only if it is structurally broken (no face, two faces), because that
 * is not a low score, it is an absent one.
 */

/** Below this, calibration is measuring noise rather than an expression. */
const MIN_SAMPLES = 5;

/**
 * The enabled presets this tenant's vocabulary can actually prompt, in picker
 * order. One question, asked in one place, by everything that needs it.
 */
async function expressible(tenantId, { vocabularyVersion = 1, client = pool } = {}) {
  const { rows: presets } = await client.query(
    `SELECT key, label, blend_with, follow_on_pass FROM expression_presets
      WHERE (tenant_id = $1 OR tenant_id IS NULL) AND enabled
      ORDER BY sort_order, key`,
    [tenantId]
  );
  const { rows: vocabulary } = await client.query(
    `SELECT facet, option_key, fragment FROM prompt_vocabulary
      WHERE version = $1 AND active`,
    [vocabularyVersion]
  );
  return expressiblePresets(vocabulary, presets);
}

/** Presets calibrated at more than one framing. A wide shot has less face to measure. */
const FRAMINGS = ['close', 'medium', 'wide'];

class CalibrationError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'CalibrationError';
    this.status = status;
    this.code = code;
  }
}

const Calibration = {
  MIN_SAMPLES,
  FRAMINGS,
  CalibrationError,
  expressible,

  /**
   * The work list: every (preset, framing) pair this LoRA still needs measured.
   *
   * Returned as a plan rather than executed here, because generating it costs
   * real money and the operator should see the number of frames before it is
   * spent — 11 presets x 3 framings x 6 samples is nearly 200 images.
   */
  async plan(tenantId, loraId, { framings = FRAMINGS, samples = 6 } = {}) {
    const { rows: loraRows } = await pool.query(
      `SELECT l.id, l.avatar_id, l.face_embedding_mean, a.slug
         FROM avatar_loras l JOIN avatars a ON a.id = l.avatar_id
        WHERE l.id = $1 AND a.tenant_id = $2`,
      [loraId, tenantId]
    );
    const lora = loraRows[0];
    if (!lora) throw new CalibrationError('LoRA not found', { status: 404 });
    if (!lora.face_embedding_mean) {
      throw new CalibrationError(
        'This model has no seed-set reference embedding — nothing to calibrate against',
        { status: 409, code: 'NO_REFERENCE' }
      );
    }

    const presets = await expressible(tenantId);

    const { rows: done } = await pool.query(
      'SELECT preset_key, framing FROM expression_baselines WHERE lora_id = $1',
      [loraId]
    );
    const have = new Set(done.map((d) => `${d.preset_key}:${d.framing}`));

    const cells = [];
    for (const preset of presets) {
      for (const framing of framings) {
        if (have.has(`${preset.key}:${framing}`)) continue;
        cells.push({ preset_key: preset.key, label: preset.label, framing, samples });
      }
    }

    return {
      avatar_id: lora.avatar_id,
      lora_id: lora.id,
      slug: lora.slug,
      cells,
      total_frames: cells.length * samples,
      // At 2 MP on fal. Shown up front because ~200 frames is a real number and
      // the operator should decide, not discover.
      estimated_cost_cents: cells.length * samples * 2 * 3.5,
    };
  },

  /**
   * Record one cell's measurements.
   *
   * `samples` are what the embedder produced for the frames of one
   * (preset, framing) cell. Structurally broken frames are dropped; low scores
   * are not.
   */
  async recordCell({ tenantId, loraId, presetKey, framing, samples }) {
    const { rows } = await pool.query(
      `SELECT l.id, l.avatar_id, l.face_embedding_mean
         FROM avatar_loras l JOIN avatars a ON a.id = l.avatar_id
        WHERE l.id = $1 AND a.tenant_id = $2`,
      [loraId, tenantId]
    );
    const lora = rows[0];
    if (!lora) throw new CalibrationError('LoRA not found', { status: 404 });

    const reference = lora.face_embedding_mean;
    const usable = [];
    const skipped = [];

    for (const [i, sample] of samples.entries()) {
      // Absent, not low. A frame with no face or two faces carries no
      // information about how far this expression moves the geometry.
      if (!sample.embedding || sample.faces !== 1) {
        skipped.push({ index: i, reason: sample.faces === 0 ? 'no_face' : 'multiple_faces' });
        continue;
      }
      usable.push(FaceQc.cosineSimilarity(sample.embedding, reference));
    }

    if (usable.length < MIN_SAMPLES) {
      throw new CalibrationError(
        `Only ${usable.length} usable frames for ${presetKey}/${framing} — need ${MIN_SAMPLES}. ` +
        `${skipped.length} were structurally unusable. Generate more before calibrating this cell, ` +
        'or the tolerance is measuring noise.',
        { status: 409, code: 'NOT_ENOUGH_SAMPLES' }
      );
    }

    const baseline = await FaceQc.calibrate({
      avatarId: lora.avatar_id,
      loraId: lora.id,
      presetKey,
      framing,
      similarities: usable,
    });

    return {
      baseline,
      used: usable.length,
      skipped,
      spread: {
        min: Math.min(...usable),
        max: Math.max(...usable),
        mean: usable.reduce((a, b) => a + b, 0) / usable.length,
      },
    };
  },

  /**
   * Is this LoRA ready to activate?
   *
   * `neutral` is required because it is the fallback every uncalibrated
   * expression degrades toward, and the emotional presets are required because
   * they are the ones a single global threshold would silently eat. A model
   * calibrated on neutral alone would pass this check and then reject every
   * laughing frame it ever made.
   */
  async readiness(tenantId, loraId) {
    const { rows } = await pool.query(
      `SELECT b.preset_key, b.framing, b.expected_similarity, b.tolerance, b.sample_count
         FROM expression_baselines b
         JOIN avatar_loras l ON l.id = b.lora_id
         JOIN avatars a ON a.id = l.avatar_id
        WHERE b.lora_id = $1 AND a.tenant_id = $2`,
      [loraId, tenantId]
    );

    const byPreset = new Map();
    for (const r of rows) {
      if (!byPreset.has(r.preset_key)) byPreset.set(r.preset_key, []);
      byPreset.get(r.preset_key).push(r);
    }

    /**
     * Which presets have to be measured before this model may be activated.
     *
     * It used to be `!blend_with && !follow_on_pass` — the presets that were
     * not deferred to an edit pass. That filter was wrong twice over: the edit
     * pass did not exist, so the deferred presets rendered a neutral face under
     * an emotional label; and the filter did not match the one in
     * `expressionHint`, so `surprised` and `anxious` were required here and
     * rendered neutral anyway. Three places answered this question and no two
     * agreed. Migration 053 has the whole story.
     *
     * Now there is one answer and it is derived: a preset must be measured when
     * the vocabulary can actually prompt it. A preset nothing can express is
     * not a gap in the calibration — it is a gap in the vocabulary, and
     * requiring a baseline for it would leave every model permanently
     * unactivatable for a cell that cannot be generated.
     */
    const measurable = (await expressible(tenantId)).map((p) => p.key);
    const missing = measurable.filter((k) => !byPreset.has(k));

    return {
      calibrated: byPreset.size,
      measurable: measurable.length,
      missing,
      ready: missing.length === 0 && byPreset.has('neutral'),
      cells: rows.length,
    };
  },

  /**
   * Calibrate, then activate.
   *
   * The two belong together: `LoraTraining.activate` refuses an uncalibrated
   * model, and a calibrated model that is never activated is a bill with no
   * benefit. This is the step that ends "your avatar is being set up".
   */
  async finish(tenantId, loraId) {
    const state = await this.readiness(tenantId, loraId);
    if (!state.ready) {
      throw new CalibrationError(
        `Not calibrated yet — still missing ${state.missing.join(', ')}. ` +
        'Activating now would put every frame through the permissive uncalibrated floor.',
        { status: 409, code: 'NOT_CALIBRATED' }
      );
    }
    const lora = await LoraTraining.activate(tenantId, loraId);
    return { lora, ...state };
  },
};

module.exports = Calibration;
