'use strict';

const pool         = require('../../config/db');
const RenderJob    = require('../../models/renderJob');
const { createStorage, isPubliclyFetchable } = require('./storageFactory');
const FaceQc       = require('./faceQc');
const CreditLedger = require('./creditLedger');

/**
 * Turning a persona bible into a face.
 *
 * Three steps, and the ordering is the whole design:
 *
 *   1. GENERATE a candidate pool from the identity block alone — no LoRA exists
 *      yet, so this is base Flux following a written description.
 *   2. CULL to a seed set. A person does this, not a score. The seed set defines
 *      who the avatar is for the rest of its life, and no automatic filter is
 *      trustworthy enough to make that call.
 *   3. TRAIN, then CALIBRATE the QC baselines against the model that came back.
 *
 * The thing worth being careful about is step 2 → 3. The mean embedding of the
 * seed set becomes the reference every future frame is compared against. Let a
 * single off-model face into it and the reference drifts toward a person who
 * does not exist, permanently, and every QC decision afterwards is made against
 * the wrong face. So the seed set is checked for internal consistency BEFORE
 * training starts — cheaply, here, rather than after paying to train.
 */

/** Below this, two images are not confidently the same person. */
const SEED_COHERENCE_FLOOR = 0.55;

/** Fewer than this and the LoRA overfits to whatever incidental detail repeats. */
const MIN_SEED_IMAGES = 12;
const MAX_SEED_IMAGES = 40;

class TrainingError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'TrainingError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Is this seed set actually one person?
 *
 * Compares every image against the set's own mean rather than against each
 * other: an outlier pulls the mean slightly, but a pairwise matrix is O(n²) and
 * answers a question nobody asked. Returns the outliers rather than a verdict,
 * because the operator decides whether to drop them or re-cull.
 */
function checkSeedCoherence(embeddings, { floor = SEED_COHERENCE_FLOOR } = {}) {
  if (embeddings.length < MIN_SEED_IMAGES) {
    throw new TrainingError(
      `A seed set needs at least ${MIN_SEED_IMAGES} images — got ${embeddings.length}. ` +
      'Fewer than that and the model learns the background instead of the face.',
      { code: 'SEED_SET_TOO_SMALL' }
    );
  }
  if (embeddings.length > MAX_SEED_IMAGES) {
    throw new TrainingError(
      `A seed set of ${embeddings.length} is past the point of diminishing returns — cap is ${MAX_SEED_IMAGES}.`,
      { code: 'SEED_SET_TOO_LARGE' }
    );
  }

  const mean = FaceQc.meanEmbedding(embeddings);
  const scores = embeddings.map((e) => FaceQc.cosineSimilarity(e, mean));
  const outliers = scores
    .map((score, index) => ({ index, score }))
    .filter((s) => s.score < floor);

  return {
    mean,
    scores,
    outliers,
    coherent: outliers.length === 0,
    minimum: Math.min(...scores),
    average: scores.reduce((a, b) => a + b, 0) / scores.length,
  };
}

/**
 * The trigger token must be a string the base model has never seen.
 *
 * This is not cosmetic. The token is what the LoRA binds the face to, and Flux
 * already has strong associations for any real word — train on `aanya` and the
 * model blends your avatar with every Aanya in its training data, so the face
 * drifts in a way no amount of prompt tuning fixes. `a4ny4prsn` collides with
 * nothing.
 *
 * A shape check alone is not enough: `aanya` is five lowercase letters and
 * passes any length-and-charset rule. Requiring a digit is a cheap, checkable
 * proxy for "not a word" — nothing in ordinary English or Hindi transliteration
 * contains one.
 */
function assertRareToken(token) {
  if (!token || !/^[a-z0-9]{6,20}$/.test(token)) {
    throw new TrainingError(
      'triggerToken must be 6-20 lowercase letters and digits',
      { code: 'BAD_TRIGGER' }
    );
  }
  if (!/[0-9]/.test(token)) {
    throw new TrainingError(
      `"${token}" reads as a word, and the base model already has associations for it — ` +
      'a trigger token must contain at least one digit so it collides with nothing (e.g. a4ny4prsn).',
      { code: 'BAD_TRIGGER' }
    );
  }
}

const LoraTraining = {
  checkSeedCoherence,
  assertRareToken,
  SEED_COHERENCE_FLOOR,
  MIN_SEED_IMAGES,
  MAX_SEED_IMAGES,
  TrainingError,

  /**
   * Queue a training run.
   *
   * Refuses on an incoherent seed set BEFORE the job exists, because training is
   * the one step here that costs real money per attempt and produces an artefact
   * that is then wrong in a way nobody notices for weeks.
   */
  async requestTraining({
    tenantId, avatarId, userId = null,
    seedSetUrl, seedEmbeddings, triggerToken,
    baseCheckpoint = 'flux1-dev.safetensors', steps = 1000, idempotencyKey = null,
  }) {
    if (!seedSetUrl) throw new TrainingError('seedSetUrl is required', { code: 'NO_SEED_SET' });
    assertRareToken(triggerToken);

    const coherence = checkSeedCoherence(seedEmbeddings);
    if (!coherence.coherent) {
      throw new TrainingError(
        `${coherence.outliers.length} of ${seedEmbeddings.length} seed images are not confidently the same person ` +
        `(lowest ${coherence.minimum.toFixed(3)} against the set mean). Drop them and re-submit — ` +
        'a seed set is permanent, and an off-model face in it moves the reference every future frame is judged against.',
        { status: 409, code: 'SEED_SET_INCOHERENT' }
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: avatarRows } = await client.query(
        'SELECT id, slug, mode, consent_record_id FROM avatars WHERE id = $1 AND tenant_id = $2',
        [avatarId, tenantId]
      );
      const avatar = avatarRows[0];
      if (!avatar) throw new TrainingError('Avatar not found', { status: 404 });

      // Same gate as generation, applied earlier. Training a likeness model is a
      // more durable act than rendering one frame of it, so consent is checked
      // before the weights exist rather than before each use.
      if (avatar.mode !== 'synthetic') {
        const { rows } = await client.query(
          'SELECT verified FROM consent_records WHERE id = $1',
          [avatar.consent_record_id]
        );
        if (!rows[0]?.verified) {
          throw new TrainingError(
            'This avatar depicts a real person and has no verified consent record',
            { status: 403, code: 'CONSENT_REQUIRED' }
          );
        }
      }

      const { rows: versionRows } = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM avatar_loras WHERE avatar_id = $1',
        [avatarId]
      );
      const version = versionRows[0].next;

      /**
       * 🐛 The `avatars` entitlement is NOT spent here. Creating the avatar
       * already spent it.
       *
       * This used to reserve on version 1, from a time when training was the
       * only place an avatar was counted. Avatar creation then started
       * reserving too — correctly, because the cap is a statement about how
       * many avatars you may HAVE, and one exists from the moment it is
       * created; the avatars list says "1 of 1 on your plan" off the row count,
       * not off this counter. Nobody removed the older reservation, so the same
       * avatar was counted twice.
       *
       * The effect was not an edge case. Every customer hits it on their first
       * training: create an avatar on a one-avatar plan, spend the slot, and
       * then be told "Not enough avatars remaining: asked for 1, 0 left of 1"
       * at the moment of paying to train the avatar they already own. Migration
       * 051 reconciles the counter for workspaces that were charged twice.
       *
       * A retrain does not charge for an avatar either, for the same reason.
       * It does now charge CREDITS — see below.
       */

      /**
       * Training costs credits, because training costs us money.
       *
       * fal bills a flat ₹200 for a run whatever happens inside it, and that
       * was absorbed: `lora_trainings` had no rate, so every run and every
       * retrain was free to the customer and unbounded. The rate card decides
       * the number; this only spends it.
       *
       * Taken INSIDE the transaction that enqueues the job, so there is no
       * instant where the credits are gone and no job exists, or the reverse.
       * Recorded on the payload as `_from_credits` — the same field seed frames
       * use — because that is what the settlement path reads to give it back
       * when a run fails permanently.
       */
      const trainingCredits = CreditLedger.creditsFor('lora_trainings', 1);
      if (trainingCredits > 0) {
        const paid = await CreditLedger.spend(
          client, tenantId, 'lora_trainings', trainingCredits, `train:${avatarId}:v${version}`);
        if (!paid) {
          const held = await CreditLedger.balance(client, tenantId);
          throw new TrainingError(
            `Training ${avatar.slug} needs ${trainingCredits} credits and you hold ${held}.`,
            { status: 402, code: 'NOT_ENOUGH_CREDITS', needed: trainingCredits, held }
          );
        }
      }

      const job = await RenderJob.enqueueTx(client, {
        tenant_id: tenantId,
        stage: 'lora_train',
        runner: 'cloud',
        priority: 40,   // ahead of rendering: nothing else can start until it lands
        label: `Training ${avatar.slug} v${version}`,
        step_index: 0,
        step_total: 1,
        payload: {
          avatar_id: avatarId,
          version,
          base_checkpoint: baseCheckpoint,
          seed_set_ref: seedSetUrl,
          seed_set_count: seedEmbeddings.length,
          // Carried so the completion handler does not have to re-embed the
          // seed set to write the reference vector.
          face_embedding_mean: coherence.mean,
          created_by: userId,
          // What this run took, so settling a permanent failure gives exactly
          // that back. Zero when the rate card prices training at nothing.
          _from_credits: trainingCredits,
          generation: {
            images_data_url: seedSetUrl,
            trigger_word: triggerToken,
            steps,
            // The SERVER knows which storage driver is configured; the worker
            // does not. Deciding here and carrying the answer means the worker
            // never has to guess reachability from the shape of a URL.
            publicly_fetchable: isPubliclyFetchable(),
          },
          _reserved: 1,
        },
        idempotency_key: idempotencyKey,
      });

      await client.query('COMMIT');
      return { job, version, coherence: { average: coherence.average, minimum: coherence.minimum } };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Record a finished training run.
   *
   * The new LoRA is written INACTIVE. Activating it is a separate, deliberate
   * step, because a fresh LoRA has no calibrated QC baselines yet — activating on
   * arrival would put every subsequent frame through the permissive uncalibrated
   * floor and let drift through unnoticed for exactly as long as nobody looked.
   */
  async recordTrained(jobId, { filePath, costCents = 0 }) {
    const job = await RenderJob.findById(jobId);
    if (!job) throw new TrainingError('Job not found', { status: 404 });
    if (job.stage !== 'lora_train') throw new TrainingError('Not a training job', { status: 400 });

    const p = job.payload || {};
    const { rows } = await pool.query(
      `INSERT INTO avatar_loras
         (avatar_id, version, file_path, trigger_token, base_checkpoint,
          seed_set_ref, seed_set_count, face_embedding_mean,
          trained_at, training_cost_cents, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW(),$9,FALSE)
       ON CONFLICT (avatar_id, version) DO UPDATE
         SET file_path = EXCLUDED.file_path, trained_at = NOW()
       RETURNING *`,
      [p.avatar_id, p.version, filePath, p.generation?.trigger_word,
       p.base_checkpoint, p.seed_set_ref, p.seed_set_count,
       JSON.stringify(p.face_embedding_mean || null), Math.round(costCents)]
    );
    return rows[0];
  },

  /**
   * Activate a LoRA.
   *
   * Refuses while the baselines are missing. The QC gate is the one thing
   * standing between a drifting model and a published photo of someone who is
   * not quite your avatar; shipping with it disabled is worse than not shipping.
   */
  async activate(tenantId, loraId, { requireCalibration = true } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT l.*, a.tenant_id FROM avatar_loras l
           JOIN avatars a ON a.id = l.avatar_id
          WHERE l.id = $1 AND a.tenant_id = $2`,
        [loraId, tenantId]
      );
      const lora = rows[0];
      if (!lora) throw new TrainingError('LoRA not found', { status: 404 });

      if (requireCalibration) {
        const { rows: baseline } = await client.query(
          'SELECT COUNT(*)::int AS n FROM expression_baselines WHERE lora_id = $1',
          [loraId]
        );
        if (!baseline[0].n) {
          throw new TrainingError(
            'This model has no calibrated QC baselines yet — calibrate before activating, ' +
            'or every frame it renders is checked against a permissive floor.',
            { status: 409, code: 'NOT_CALIBRATED' }
          );
        }
      }

      // Exactly one active LoRA per avatar. Two would make "which model made
      // this frame" unanswerable, and the baselines are keyed per LoRA.
      await client.query('UPDATE avatar_loras SET active = FALSE WHERE avatar_id = $1', [lora.avatar_id]);
      const { rows: activated } = await client.query(
        'UPDATE avatar_loras SET active = TRUE WHERE id = $1 RETURNING *', [loraId]
      );

      await client.query('COMMIT');
      return activated[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Where the seed set is uploaded to.
   *
   * Private, not public: these are the training images of a face, and the
   * published-media bucket path is world-readable so Instagram can fetch from it.
   */
  /**
   * What one training run costs, in cents.
   *
   * Read from the same env var the worker prices the finished job with, so the
   * number on the button and the number on the invoice come from one place. A
   * screen that quotes its own constant is a screen that is eventually wrong.
   */
  trainingPriceCents() {
    return Number(process.env.FAL_PRICE_LORA_TRAIN_CENTS ?? 200);
  },

  seedSetTarget({ tenantId, avatarSlug }) {
    const storage = createStorage();
    return storage.uploadTarget({
      tenantId, avatarSlug, projectId: 'seed', kind: 'lora',
      filename: 'seed-set.zip', contentType: 'application/octet-stream',
      expiresIn: 3600,
    });
  },
};

module.exports = LoraTraining;
