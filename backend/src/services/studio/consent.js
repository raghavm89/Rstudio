"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const pool = require("./../../config/db");

/**
 * Clone consent — create a record, and verify it is the same person.
 *
 * A `twin` avatar depicts a REAL person, so nothing may train or generate one
 * until a verified consent record exists (the gate is already enforced in the
 * orchestrator, training and avatar reads). This is the other half: producing
 * that record. Consent is a hosted capture — the person records a short video
 * saying the consent statement — and verification is a SAME-PERSON face match
 * between that capture and the reference material the clone is built from.
 *
 * Same mechanism as shoot QC: an ArcFace-family embedding compared by cosine
 * angle. The measurement (insightface) is injectable so the logic is testable
 * without the model or a network call.
 *
 * NOT in scope here, and deliberately: the legal STATEMENT wording, retention
 * and revocation policy. Those need an Indian lawyer (see the offering spec);
 * this module is the technical identity check, not the legal instrument.
 */

const SAME_PERSON_THRESHOLD = Number(process.env.CONSENT_MATCH_THRESHOLD ?? 0.55);

class ConsentError extends Error {
  constructor(message, { status = 400, code = null, permanent = false } = {}) {
    super(message);
    this.name = "ConsentError";
    this.status = status;
    this.code = code;
    this.permanent = permanent;
  }
}

/** Cosine similarity of two embeddings, in [-1, 1]. Pure. */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    throw new ConsentError("Cannot compare embeddings of different or zero length", { code: "BAD_EMBEDDING" });
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Is this similarity a same-person match? Pure. */
function isSamePerson(similarity, threshold = SAME_PERSON_THRESHOLD) {
  return typeof similarity === "number" && similarity >= threshold;
}

async function downloadToTemp(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new ConsentError(`Could not fetch consent material (${res.status})`, { status: 502, permanent: res.status >= 400 && res.status < 500 });
  const buf = Buffer.from(await res.arrayBuffer());
  const p = path.join(os.tmpdir(), `rstudio-consent-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(p, buf);
  return p;
}

const Consent = {
  SAME_PERSON_THRESHOLD,
  ConsentError,
  cosineSimilarity,
  isSamePerson,

  /** Create an (unverified) consent record and link it to the avatar. */
  async create(client, { tenantId, avatarId, subjectName, method = "hosted_capture", statementLanguage = null, videoUrl = null, referenceAssetUrl = null, notes = null }) {
    if (!subjectName) throw new ConsentError("subject_name is required", { code: "NO_SUBJECT" });
    const { rows } = await client.query(
      `INSERT INTO consent_records (tenant_id, subject_name, method, statement_language, video_url, reference_asset_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, subjectName, method, statementLanguage, videoUrl, referenceAssetUrl, notes]
    );
    const record = rows[0];
    if (avatarId) {
      // Link it to the avatar — scoped to the tenant so one tenant cannot attach
      // a consent record to another's avatar.
      const upd = await client.query(
        `UPDATE avatars SET consent_record_id = $1, updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3 RETURNING id`,
        [record.id, avatarId, tenantId]
      );
      if (!upd.rows[0]) throw new ConsentError("No such avatar in this workspace", { status: 404, code: "NO_AVATAR" });
    }
    return record;
  },

  /**
   * Verify a consent record: measure the face in the consent video and in the
   * reference material, and mark it verified only if they are the same person.
   * A mismatch is recorded (match_score, still unverified), not an error — the
   * caller sees it failed the check.
   */
  async verify(client, { recordId, tenantId, verifiedBy = null, threshold = SAME_PERSON_THRESHOLD }, deps = {}) {
    const { rows } = await client.query(
      `SELECT * FROM consent_records WHERE id = $1 AND tenant_id = $2`,
      [recordId, tenantId]
    );
    const rec = rows[0];
    if (!rec) throw new ConsentError("No such consent record", { status: 404, code: "NO_RECORD" });

    const faceUrl = deps.faceUrl || rec.video_url;
    const refUrl = deps.refUrl || rec.reference_asset_url;
    if (!faceUrl || !refUrl) {
      throw new ConsentError("Consent record needs both a captured video and reference material to verify", { status: 409, code: "MISSING_MATERIAL" });
    }

    const measure = deps.measure || defaultMeasure(deps);
    const [faceEmb, refEmb] = await Promise.all([measure(faceUrl), measure(refUrl)]);
    if (!Array.isArray(faceEmb) || !Array.isArray(refEmb)) {
      throw new ConsentError("Could not measure a face in the consent video or the reference", { status: 422, code: "NO_FACE" });
    }

    const similarity = cosineSimilarity(faceEmb, refEmb);
    const same = isSamePerson(similarity, threshold);

    await client.query(
      `UPDATE consent_records
          SET match_score = $2,
              verified    = $3,
              verified_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
              verified_by = CASE WHEN $3 THEN $4 ELSE NULL END
        WHERE id = $1`,
      [recordId, Number(similarity.toFixed(4)), same, verifiedBy]
    );

    return { verified: same, matchScore: Number(similarity.toFixed(4)), threshold };
  },
};

/**
 * insightface reads a still, but a hosted consent capture is a short VIDEO. So
 * a downloaded file that looks like a video is reduced to one representative
 * frame first (ffmpeg, ~0.5s in to skip a black first frame). A still URL is
 * embedded as-is. ffmpeg missing on a video is a clear, non-permanent failure —
 * the same class as insightface being absent.
 */
const { execFile } = require('child_process');
const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|avi)(\?|#|$)/i;
function videoToStill(inPath) {
  return new Promise((resolve, reject) => {
    const out = inPath + '.consent-frame.jpg';
    execFile('ffmpeg', ['-y', '-ss', '0.5', '-i', inPath, '-frames:v', '1', out],
      { timeout: 60000 }, (err) => {
        if (err) {
          return reject(new ConsentError(
            'Could not read a frame from the consent video' +
            (/ENOENT/.test(String(err.message)) ? ' — ffmpeg is not installed on this host' : ''),
            { status: err && /ENOENT/.test(String(err.message)) ? 503 : 422, code: 'VIDEO_DECODE' }));
        }
        resolve(out);
      });
  });
}

/** The real face measurer: download each URL and embed it (insightface). */
function defaultMeasure(deps) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const embedder = deps.embedder;
  if (!embedder) {
    return async () => { throw new ConsentError("No face embedder available to verify consent", { status: 503, code: "NO_EMBEDDER" }); };
  }
  return async (url) => {
    const tmp = await downloadToTemp(url, fetchImpl);
    let still = null;
    try {
      const imagePath = VIDEO_RE.test(String(url)) ? (still = await videoToStill(tmp)) : tmp;
      const m = await embedder.embed(imagePath, {});
      return Array.isArray(m.embedding) ? m.embedding : null;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (still) await fs.rm(still, { force: true }).catch(() => {});
    }
  };
}

module.exports = Consent;
