#!/usr/bin/env node
'use strict';

/**
 * Character-upload ingest (mode 3) — the core the operator script and any later
 * in-app job share.
 *
 * A character built from an uploaded image (decision-character-avatars-mode3.md)
 * needs that image turned into training material the existing pipeline can use.
 * The elegant reuse: store the upload as the avatar's ANCHOR seed candidate and
 * point `anchor_candidate_id` at it — then the normal "anchor and vary" seed
 * generation produces a pool of variations conditioned on the upload, exactly as
 * a claimed catalogue face does. No new model wiring; the upload becomes the
 * reference every generated frame is drawn from.
 *
 * The gate is the attestation, not consent: a character depicts nobody, so there
 * is no same-person match — there is a logged "I hold the rights" that MUST be
 * active before any of the upload is written into the pipeline. That check is
 * first, before a byte is stored.
 *
 * Runs where the DB + storage are (the Mac, in a script). Nothing goes to fal.
 *
 * On the embedding: a whole-image (CLIP) usability check is OPTIONAL here and
 * only confirms the file is a readable image — the reference MEAN is computed
 * downstream by the `embed` stage (which already selects the CLIP embedder for a
 * character via embedderFactory). So ingest does not hard-depend on the torch
 * env; pass an embedder to get the stricter check, omit it for a basic one.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../../config/db');
const { createStorage } = require('./storageFactory');
const CharacterAttestation = require('./characterAttestation');

class CharacterIngestError extends Error {
  constructor(message, code) { super(message); this.name = 'CharacterIngestError'; this.code = code; }
}

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

function listImages(dir) {
  return fs.readdirSync(dir).filter((f) => IMAGE_RE.test(f)).sort().map((f) => path.join(dir, f));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function contentTypeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' })[ext] || 'image/png';
}

/** Store one image, disk-direct where possible (mirrors twinIngest.storeFrame). */
async function storeImage(storage, { tenantId, avatarSlug, filename, buf }) {
  const args = { tenantId, avatarSlug, projectId: 'character-upload', kind: 'seed', filename, contentType: contentTypeFor(filename) };
  if (typeof storage.pathFor === 'function') {
    const key = storage.keyFor(args);
    const full = storage.pathFor(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return key;
  }
  const t = storage.uploadTarget(args);
  const res = await fetch(t.url, { method: 'PUT', headers: t.headers, body: buf });
  if (!res.ok) throw new CharacterIngestError(`storage PUT failed HTTP ${res.status}`, 'STORE');
  return t.key;
}

/**
 * A readable image? If an embedder is supplied, use it (a CLIP embedding exists
 * for any decodable image, and a permanent failure means the file will never
 * decode). Otherwise a basic non-empty check — ingest must not require torch.
 */
async function isReadable(buf, filePath, embedder) {
  if (!buf || !buf.length) return false;
  if (!embedder) return true;
  try {
    const out = await embedder.embed(filePath, {});
    return Array.isArray(out.embedding);
  } catch (err) {
    if (err && err.permanent) return false; // undecodable
    return true; // embedder unavailable / transient — don't block the upload on it
  }
}

/**
 * Ingest uploaded character reference image(s).
 *
 * @param {number}   avatarId
 * @param {number}   tenantId
 * @param {string[]} sources   local image file paths (operator), OR pass `dir`.
 * @param {string}   dir       a folder of images (alternative to `sources`).
 * @param {object}   embedder  optional ClipEmbedder for the stricter readability check.
 */
async function ingest({ avatarId, tenantId, sources = null, dir = null, embedder = null, onProgress = () => {} }) {
  const files = sources && sources.length ? sources : (dir ? listImages(dir) : []);
  if (!files.length) throw new CharacterIngestError('No image files to ingest', 'NO_FILES');

  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, slug, name, subject_type, character_source, anchor_candidate_id FROM avatars WHERE id = $1 AND tenant_id = $2',
    [avatarId, tenantId]);
  const avatar = av[0];
  if (!avatar) throw new CharacterIngestError('No such avatar in this workspace', 'NO_AVATAR');
  if (avatar.subject_type !== 'character') throw new CharacterIngestError('Only a character avatar takes an uploaded reference', 'NOT_A_CHARACTER');

  // THE GATE — before any byte is written into the pipeline. A missing or
  // inactive attestation stops here; there is nothing to ingest without one.
  onProgress('Checking the rights attestation…');
  const attestation = await CharacterAttestation.active(pool, { avatarId, tenantId });
  if (!attestation) {
    throw new CharacterIngestError(
      'No active rights attestation for this character. Record the upload attestation first.', 'NO_ATTESTATION');
  }

  onProgress('Reading the uploaded image(s)…');
  const usable = [];
  for (const fp of files) {
    let buf;
    try { buf = fs.readFileSync(fp); } catch { continue; }
    if (await isReadable(buf, fp, embedder)) usable.push({ path: fp, buf });
  }
  if (!usable.length) throw new CharacterIngestError('None of the uploads were readable images.', 'NO_USABLE');

  onProgress('Saving the reference…');
  const storage = createStorage();
  const batch = `upload-${Date.now().toString(36)}`;
  let anchorId = null;
  let anchorHash = null;
  let anchorKey = null;
  let poolN = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A fresh upload replaces any prior anchor for this avatar (the unique index
    // allows only one), so re-ingesting a corrected image is clean.
    if (avatar.anchor_candidate_id) {
      await client.query(`UPDATE seed_candidates SET kind = 'pool' WHERE id = $1 AND avatar_id = $2`,
        [avatar.anchor_candidate_id, avatarId]);
    }

    for (let i = 0; i < usable.length; i += 1) {
      const item = usable[i];
      const isAnchor = i === 0; // the first readable upload is the anchor others vary from
      const base = `${String(i + 1).padStart(4, '0')}-upload-${path.basename(item.path)}`
        .replace(/[^A-Za-z0-9._-]/g, '_');
      const storageKey = await storeImage(storage, { tenantId, avatarSlug: avatar.slug, filename: base, buf: item.buf });
      const { rows } = await client.query(
        `INSERT INTO seed_candidates (avatar_id, filename, idx, angle, framing, quality, seed, storage_key, job_id, batch, kind)
         VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,$4,NULL,$5,$6)
         ON CONFLICT (avatar_id, filename) DO UPDATE SET storage_key = EXCLUDED.storage_key, kind = EXCLUDED.kind
         RETURNING id`,
        [avatarId, base, i, storageKey, batch, isAnchor ? 'anchor' : 'pool']);
      if (isAnchor) {
        anchorId = rows[0].id;
        anchorHash = sha256(item.buf);
        anchorKey = storageKey;
      } else {
        poolN += 1;
      }
    }

    // Point the avatar at the anchor so "anchor and vary" generation conditions
    // its pool on the upload.
    await client.query(`UPDATE avatars SET anchor_candidate_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [anchorId, avatarId, tenantId]);

    // Stamp the attestation with the exact bytes it now covers.
    await CharacterAttestation.recordUpload(client, { attestationId: attestation.id, sourceHash: anchorHash, uploadRef: anchorKey });

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw new CharacterIngestError(`Could not save the upload: ${e.message}`, 'WRITE');
  } finally {
    client.release();
  }

  return { anchorId, anchorHash, pool: poolN, batch, attestationId: attestation.id };
}

module.exports = { ingest, CharacterIngestError };
