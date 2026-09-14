'use strict';

const pool = require('../../config/db');

/**
 * Face QC — is this still the same person?
 *
 * The worker extracts a face embedding (insightface / ArcFace on the Mac; the
 * model lives with the worker, not here) and posts the vector back. This module
 * owns the judgement, which is the part with the interesting failure mode:
 *
 *   A CRYING FACE LEGITIMATELY SCORES LOWER THAN A NEUTRAL ONE.
 *
 * Geometry genuinely moved. A single global threshold therefore auto-rejects
 * precisely the most emotional and most engaging shots — silently — and you
 * conclude the model "can't do crying" when the gate is eating them. So the
 * threshold is per (avatar, LoRA, expression, framing), calibrated once at
 * avatar setup, and the check is a deviation from THAT expectation rather than
 * from neutral.
 *
 * Framing matters for the same reason: a wide shot has fewer face pixels, so it
 * scores lower without the identity being any less correct.
 */

// Used only when no baseline exists yet — a persona that has not been
// calibrated. Deliberately permissive: a missing baseline should not silently
// reject everything on day one.
const UNCALIBRATED_FLOOR = 0.60;

// The confident-identity bar. Calibration is measured on low-variance setup
// renders, so a per-expression floor (expected - 2σ) can land at 0.76-0.80 —
// well above what identity requires (ArcFace same-person is >0.6). Real
// production frames (festive wardrobe, three-quarter poses, busy scenes)
// legitimately score lower yet are unmistakably the persona, and were being
// rejected as `below_baseline`. This CAPS how strict a calibrated floor may be:
// a frame that clears this bar passes regardless. Calibration still governs
// wherever it is LOOSER than this (a hard expression like laughing), and still
// catches a genuine miss below it. Tune with STUDIO_QC_IDENTITY_FLOOR.
const IDENTITY_FLOOR = Number(process.env.STUDIO_QC_IDENTITY_FLOOR) || 0.68;

/**
 * Which embedder measures identity, by avatar subject type.
 *
 *   person    → a FACE embedding (insightface/ArcFace); this whole module's
 *               thresholds and the 0.60 floor are ArcFace numbers.
 *   character → a WHOLE-IMAGE (CLIP) embedding, because a personified fruit has
 *               no face to detect. The cosine judgement below is identical — CLIP
 *               vectors compare by angle too — but the floor/baseline must be
 *               re-tuned for CLIP's distribution (Phase B; see
 *               claude/character-line-scope.md, CA5).
 *
 * The worker reads this to pick its extractor; the judgement here reads
 * `subjectType` to skip the face-only structural rejects for a character.
 */
const EMBEDDER_BY_SUBJECT = {
  person:    'insightface',
  character: 'clip',
};

/** The extractor name for a subject type, defaulting to the person path. */
function embedderFor(subjectType) {
  return EMBEDDER_BY_SUBJECT[subjectType] || EMBEDDER_BY_SUBJECT.person;
}

const REJECT = {
  BELOW_BASELINE: 'below_baseline',
  NO_FACE: 'no_face',
  MULTIPLE_FACES: 'multiple_faces',
  MALFORMED_HANDS: 'hands',
  TEXT_ARTIFACT: 'text_artifact',
  WRONG_ASPECT: 'aspect',
};

/**
 * Cosine similarity between two embeddings.
 *
 * Face embeddings are compared by angle, not distance — magnitude carries no
 * identity information. Returns a value in [-1, 1]; ArcFace-family embeddings of
 * the same person typically land above 0.6, different people below 0.3.
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError('Embeddings must be arrays of numbers');
  }
  if (a.length !== b.length) {
    throw new RangeError(`Embedding length mismatch: ${a.length} vs ${b.length}`);
  }
  if (!a.length) throw new RangeError('Embeddings must not be empty');

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Mean of N embeddings, for the seed-set reference vector. */
function meanEmbedding(embeddings) {
  if (!embeddings.length) throw new RangeError('Need at least one embedding');
  const dim = embeddings[0].length;
  const out = new Array(dim).fill(0);
  for (const e of embeddings) {
    if (e.length !== dim) throw new RangeError('All embeddings must share a dimension');
    for (let i = 0; i < dim; i += 1) out[i] += e[i];
  }
  return out.map((v) => v / embeddings.length);
}

/**
 * Resolve the expected similarity for this shot.
 *
 * Falls back in the order that degrades least: exact (expression + framing) →
 * same expression, any framing → uncalibrated floor. Never falls back to a
 * neutral baseline for an emotional shot, which is the whole bug this avoids.
 */
async function resolveBaseline(client, { avatarId, loraId, presetKey, framing }) {
  const exact = await client.query(
    `SELECT expected_similarity, tolerance, sample_count FROM expression_baselines
      WHERE avatar_id = $1 AND lora_id = $2 AND preset_key = $3 AND framing = $4`,
    [avatarId, loraId, presetKey, framing]
  );
  if (exact.rows[0]) return { ...exact.rows[0], source: 'exact' };

  const anyFraming = await client.query(
    `SELECT AVG(expected_similarity) AS expected_similarity,
            MAX(tolerance)           AS tolerance,
            SUM(sample_count)::int   AS sample_count
       FROM expression_baselines
      WHERE avatar_id = $1 AND lora_id = $2 AND preset_key = $3`,
    [avatarId, loraId, presetKey]
  );
  if (anyFraming.rows[0]?.expected_similarity !== null && anyFraming.rows[0]?.expected_similarity !== undefined) {
    return { ...anyFraming.rows[0], source: 'expression' };
  }

  return {
    expected_similarity: UNCALIBRATED_FLOOR,
    tolerance: 0,
    sample_count: 0,
    source: 'uncalibrated',
  };
}

const FaceQc = {
  cosineSimilarity,
  meanEmbedding,
  REJECT,
  UNCALIBRATED_FLOOR,
  EMBEDDER_BY_SUBJECT,
  embedderFor,

  /**
   * Judge one candidate.
   *
   * `detections` comes from the worker's face detector. Structural failures are
   * checked before similarity, because there is no point comparing an embedding
   * from an image containing two faces.
   */
  async evaluate({
    avatarId, loraId, presetKey = 'neutral', framing = 'medium',
    embedding, referenceEmbedding, detections = {}, aspect = null, expectedAspect = null,
    subjectType = 'person',
  }) {
    const client = await pool.connect();
    try {
      // The face-count and hand rejects come from a FACE detector, which never
      // runs for a character — a personified fruit has no face, and reporting
      // zero faces would auto-reject every good frame. For a character, identity
      // rides on the whole-image (CLIP) similarity below alone. The aspect and
      // text-artifact rejects are generic image-quality checks and apply to both.
      const isCharacter = subjectType === 'character';
      if (!isCharacter) {
        if (detections.faceCount === 0) {
          return { pass: false, reason: REJECT.NO_FACE, similarity: null };
        }
        if (detections.faceCount > 1) {
          return { pass: false, reason: REJECT.MULTIPLE_FACES, similarity: null };
        }
        if (detections.malformedHands) {
          return { pass: false, reason: REJECT.MALFORMED_HANDS, similarity: null };
        }
      }
      if (detections.textArtifact) {
        return { pass: false, reason: REJECT.TEXT_ARTIFACT, similarity: null };
      }
      if (aspect && expectedAspect && Math.abs(aspect - expectedAspect) > 0.02) {
        return { pass: false, reason: REJECT.WRONG_ASPECT, similarity: null };
      }

      const similarity = cosineSimilarity(embedding, referenceEmbedding);
      const baseline = await resolveBaseline(client, { avatarId, loraId, presetKey, framing });

      const expected  = Number(baseline.expected_similarity);
      const tolerance = Number(baseline.tolerance || 0);
      const calibratedFloor = expected - tolerance;
      // Calibration may only be as strict as the confident-identity bar. A frame
      // that clears IDENTITY_FLOOR is the persona and passes even when a tight,
      // low-variance calibration set would reject it; calibration still governs
      // where it is looser than the bar.
      const floor = Math.min(calibratedFloor, IDENTITY_FLOOR);
      const pass  = similarity >= floor;

      return {
        pass,
        reason: pass ? null : REJECT.BELOW_BASELINE,
        similarity: Number(similarity.toFixed(4)),
        expected: Number(expected.toFixed(4)),
        floor: Number(floor.toFixed(4)),
        calibratedFloor: Number(calibratedFloor.toFixed(4)),
        identityFloor: IDENTITY_FLOOR,
        baselineSource: baseline.source,
        // Surfaced so the UI can say "we have not measured 'crying' for her yet"
        // instead of implying a threshold that was never calibrated.
        calibrated: baseline.source !== 'uncalibrated',
      };
    } finally {
      client.release();
    }
  },

  /**
   * Calibrate one (avatar, LoRA, expression, framing) from sample similarities.
   *
   * Run once at avatar setup for every preset. Tolerance is two standard
   * deviations, floored at 0.03 so a suspiciously tight sample does not produce
   * a threshold nothing can pass, and capped at 0.15 so a noisy one does not
   * produce a gate that lets anything through.
   */
  async calibrate({ avatarId, loraId, presetKey, framing = 'medium', similarities }) {
    if (!Array.isArray(similarities) || similarities.length < 3) {
      throw new RangeError('Need at least 3 samples to calibrate a baseline');
    }
    const n    = similarities.length;
    const mean = similarities.reduce((a, b) => a + b, 0) / n;
    const variance = similarities.reduce((acc, s) => acc + (s - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const tolerance = Math.min(0.15, Math.max(0.03, stdDev * 2));

    const { rows } = await pool.query(
      `INSERT INTO expression_baselines
         (avatar_id, lora_id, preset_key, framing, expected_similarity, tolerance, sample_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (avatar_id, lora_id, preset_key, framing)
       DO UPDATE SET expected_similarity = EXCLUDED.expected_similarity,
                     tolerance           = EXCLUDED.tolerance,
                     sample_count        = EXCLUDED.sample_count,
                     calibrated_at       = NOW()
       RETURNING *`,
      [avatarId, loraId, presetKey, framing, mean.toFixed(4), tolerance.toFixed(4), n]
    );
    return rows[0];
  },

  /**
   * Which presets still have no baseline — the setup checklist.
   *
   * Counts only presets the vocabulary can prompt. It used to count every
   * enabled one, which made it the THIRD answer to that question in this
   * codebase and the most generous: it would have listed a preset nothing could
   * generate as permanently uncalibrated, and a checklist with a line nobody
   * can ever tick is worse than no checklist. See migration 053.
   *
   * Reads the tenant from the avatar rather than taking it, because every
   * caller has an avatar id and none of them should have to know that platform
   * presets are the ones with a null tenant.
   */
  async uncalibratedPresets(avatarId, loraId) {
    const { rows: owner } = await pool.query('SELECT tenant_id FROM avatars WHERE id = $1', [avatarId]);
    if (!owner[0]) return [];

    const presets = await require('./calibration').expressible(owner[0].tenant_id);
    const { rows: have } = await pool.query(
      'SELECT preset_key FROM expression_baselines WHERE avatar_id = $1 AND lora_id = $2',
      [avatarId, loraId]
    );
    const measured = new Set(have.map((r) => r.preset_key));
    return presets.map((p) => p.key).filter((k) => !measured.has(k));
  },
};

module.exports = FaceQc;
