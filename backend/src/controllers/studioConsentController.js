"use strict";

const Consent = require("../services/studio/consent");
const pool = require("../config/db");

// One long-lived embedder for verification (loading insightface costs seconds).
let _embedder = null;
function getEmbedder() {
  if (!_embedder) {
    const { FaceEmbedder } = require("../../worker/faceEmbed");
    _embedder = new FaceEmbedder();
  }
  return _embedder;
}

// POST /api/studio/avatars/:id/consent — create a consent record for a clone.
exports.create = async (req, res) => {
  const avatarId = Number(req.params.id);
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await Consent.create(client, {
      tenantId: req.user.tenant_id,
      avatarId,
      subjectName: b.subject_name,
      method: b.method,
      statementLanguage: b.statement_language,
      videoUrl: b.video_url,
      referenceAssetUrl: b.reference_asset_url,
      notes: b.notes,
    });
    await client.query("COMMIT");
    return res.status(201).json(record);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  } finally {
    client.release();
  }
};

// POST /api/studio/consent/:id/verify — same-person face match, mark verified.
exports.verify = async (req, res) => {
  const recordId = Number(req.params.id);
  const client = await pool.connect();
  try {
    const out = await Consent.verify(
      client,
      { recordId, tenantId: req.user.tenant_id, verifiedBy: req.user.id },
      { embedder: getEmbedder() }
    );
    return res.json(out);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  } finally {
    client.release();
  }
};
