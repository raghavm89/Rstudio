"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const pool = require("../../config/db");
const FaceQc = require("./faceQc");
const { createStorage } = require("./storageFactory");

/**
 * The `qc` stage — is this shot's still the same person, and which frame is best?
 *
 * A still job renders one or more candidate frames (recorded as studio_assets by
 * the still-completion path). QC:
 *   1. measures a face embedding for each candidate (insightface, via the
 *      injectable embedder — the model lives with the worker, not here),
 *   2. judges it against the LoRA's reference embedding at the calibrated
 *      baseline for THIS (expression, framing) — faceQc owns that judgement,
 *   3. writes the verdict (qc_status, similarity, reason) onto each asset,
 *   4. selects the best PASSING frame and re-points this shot's motion job at
 *      it (overwriting the arbitrary first-frame default the still path set).
 *
 * If NO candidate passes, this throws a permanent error so the runner blocks the
 * motion that would otherwise animate a rejected face — the honest outcome is
 * "this shot produced nothing usable", not a bad video.
 *
 * Measurement is split from judgement (the embedder just measures) so thresholds
 * stay per-(avatar, LoRA, expression, framing) and recalibrate without touching
 * the extractor. The embedder and judge are injectable so the orchestration is
 * testable without insightface or a database.
 */

class QcError extends Error {
  constructor(message, { permanent = false, qcResult = null } = {}) {
    super(message);
    this.name = "QcError";
    this.permanent = permanent;
    this.qcResult = qcResult;
  }
}

/** The best PASSING candidate by similarity. Pure. */
function selectBest(results) {
  const passing = (results || []).filter((r) => r.pass && typeof r.similarity === "number");
  if (!passing.length) return null;
  return passing.reduce((a, b) => (b.similarity > a.similarity ? b : a));
}

async function downloadToTemp(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new QcError(`QC could not fetch a frame (${res.status})`, { permanent: res.status >= 400 && res.status < 500 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const p = path.join(os.tmpdir(), `rstudio-qc-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  await fs.writeFile(p, buf);
  return p;
}

async function feedMotion(client, { projectId, shotId, imageUrl }) {
  const { rows } = await client.query(
    `SELECT id, payload FROM render_jobs
      WHERE project_id = $1 AND stage = 'motion' AND shot_id = $2
      ORDER BY id LIMIT 1`,
    [projectId, shotId]
  );
  if (!rows[0]) return false;
  const g = { ...(rows[0].payload?.generation || {}), image_url: imageUrl };
  await client.query(
    `UPDATE render_jobs SET payload = jsonb_set(payload, '{generation}', $2::jsonb, true), updated_at = NOW()
      WHERE id = $1`,
    [rows[0].id, JSON.stringify(g)]
  );
  return true;
}

async function runQc(job, deps = {}) {
  if (job.stage !== "qc") throw new QcError(`Not a qc job: stage is "${job.stage}"`, { permanent: true });
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const storage = deps.storage || createStorage();
  const judge = deps.judge || ((a) => FaceQc.evaluate(a));
  const embedder = deps.embedder;
  if (!embedder) throw new QcError("QC needs a face embedder", { permanent: false });

  const ownClient = !deps.db;
  const client = deps.db || (await pool.connect());
  try {
    const p = job.payload || {};
    const projectId = job.project_id;
    const shotId = job.shot_id;

    const { rows: candidates } = await client.query(
      `SELECT id, storage_url, candidate_index FROM studio_assets
        WHERE project_id = $1 AND shot_id = $2 AND kind = 'still'
        ORDER BY candidate_index`,
      [projectId, shotId]
    );
    if (!candidates.length) throw new QcError("No candidate frames to QC", { permanent: true });

    let reference = deps.reference || null;
    if (!reference) {
      const { rows } = await client.query(`SELECT face_embedding_mean FROM avatar_loras WHERE id = $1`, [p.lora_id]);
      reference = rows[0]?.face_embedding_mean || null;
    }

    const results = [];
    for (const c of candidates) {
      if (!c.storage_url) {
        results.push({ asset_id: c.id, storage_url: null, pass: false, reason: "no_url", similarity: null });
        await client.query(`UPDATE studio_assets SET qc_status='rejected', qc_reason='no_url' WHERE id=$1`, [c.id]);
        continue;
      }
      const tmp = await downloadToTemp(storage.readUrl ? c.storage_url : c.storage_url, fetchImpl);
      let verdict;
      try {
        const m = await embedder.embed(tmp, { expectAspect: p.expected_aspect ?? null });
        verdict = await judge({
          avatarId: p.avatar_id, loraId: p.lora_id, presetKey: p.preset_key, framing: p.framing,
          embedding: m.embedding, referenceEmbedding: reference,
          detections: { faceCount: Number(m.faces || 0) },
          aspect: m.aspect ?? null, expectedAspect: p.expected_aspect ?? null,
          // person → face rejects apply; character → they are skipped (no face
          // to detect), and identity rides on the CLIP embedding alone.
          subjectType: p.subject_type || 'person',
        });
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      await client.query(
        `UPDATE studio_assets SET qc_status = $2, qc_reason = $3, face_similarity = $4 WHERE id = $1`,
        [c.id, verdict.pass ? "passed" : "rejected", verdict.reason, verdict.similarity]
      );
      results.push({ asset_id: c.id, storage_url: c.storage_url, pass: verdict.pass, reason: verdict.reason, similarity: verdict.similarity });
    }

    const best = selectBest(results);
    if (!best) {
      throw new QcError(`No candidate passed QC for shot ${shotId}`, {
        permanent: true,
        qcResult: { candidates: results, selected: null, passed: 0 },
      });
    }

    // One selected per (shot, kind): clear the old winner, then set the new one.
    await client.query(`UPDATE studio_assets SET selected = false WHERE shot_id = $1 AND kind = 'still' AND selected`, [shotId]);
    await client.query(`UPDATE studio_assets SET selected = true WHERE id = $1`, [best.asset_id]);
    const motionFed = await feedMotion(client, { projectId, shotId, imageUrl: best.storage_url });

    return {
      ok: true,
      result: {
        candidates: results,
        selected: best.asset_id,
        similarity: best.similarity,
        passed: results.filter((r) => r.pass).length,
        motionFed,
      },
    };
  } finally {
    if (ownClient) client.release();
  }
}

module.exports = { runQc, selectBest, feedMotion, QcError };
