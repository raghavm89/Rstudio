#!/usr/bin/env node
'use strict';

/**
 * Twin ingest — the core the in-app flow and the operator script share.
 *
 * A twin's training photos come from the real person's own footage. This takes
 * a local video (or a folder of images), extracts frames (ffmpeg), keeps the
 * ones with a single clear face (insightface), verifies the footage is the same
 * person as the recorded CONSENT video, and — only then — writes the frames into
 * `seed_candidates` in the same shape the synthetic pipeline uses. So the cull
 * screen and train.js work on a twin unchanged.
 *
 * Runs where the DB + insightface + ffmpeg are (the Mac, in the API process or
 * a script). Nothing goes to fal.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const pool = require('../../config/db');
const { createStorage } = require('./storageFactory');
const { FaceEmbedder } = require('../../../worker/faceEmbed');
const Consent = require('./consent');

class TwinIngestError extends Error {
  constructor(message, code) { super(message); this.name = 'TwinIngestError'; this.code = code; }
}

function ffprobeDuration(p) {
  try {
    const out = execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', p],
      { encoding: 'utf8' });
    return parseFloat(String(out).trim()) || 0;
  } catch { return 0; }
}

function extractFrames(video, outDir, target) {
  fs.mkdirSync(outDir, { recursive: true });
  const dur = ffprobeDuration(video);
  const rate = dur > 0 ? target / dur : 1;
  execFileSync('ffmpeg',
    ['-y', '-i', video, '-vf', `fps=${rate.toFixed(4)}`, '-qscale:v', '3',
     path.join(outDir, 'f%04d.jpg')], { stdio: 'ignore' });
  return fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(outDir, f));
}

function oneFrame(video, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'consent-frame.jpg');
  execFileSync('ffmpeg', ['-y', '-ss', '0.5', '-i', video, '-frames:v', '1', out], { stdio: 'ignore' });
  return out;
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new TwinIngestError(`Could not read the consent video (HTTP ${res.status})`, 'CONSENT_FETCH');
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function meanVec(vecs) {
  const d = vecs[0].length;
  const out = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i += 1) out[i] += v[i];
  return out.map((x) => x / vecs.length);
}

function listImages(dir) {
  return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f)).sort().map((f) => path.join(dir, f));
}

function sample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.floor(i * step)]);
  return out;
}

async function storeFrame(storage, { tenantId, avatarSlug, filename, buf }) {
  const args = { tenantId, avatarSlug, projectId: 'seed', kind: 'twin', filename, contentType: 'image/jpeg' };
  if (typeof storage.pathFor === 'function') {
    const key = storage.keyFor(args);
    const full = storage.pathFor(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return key;
  }
  const t = storage.uploadTarget(args);
  const res = await fetch(t.url, { method: 'PUT', headers: t.headers, body: buf });
  if (!res.ok) throw new TwinIngestError(`storage PUT failed HTTP ${res.status}`, 'STORE');
  return t.key;
}

/**
 * Ingest a twin's footage. `sourcePath` is a local video (isVideo) or an image
 * folder. Throws TwinIngestError with a user-safe message on any failure, so a
 * caller can surface it.
 */
// ── Mapping a measured frame onto the coverage grid ──────────────────────────
// A twin's frames come from uploaded video with no cell labels, so derive them
// from what insightface measured: yaw -> angle (the axis that decides whether a
// profile renders as a different person), face fraction -> framing, luminance
// spread -> light. Null when unmeasurable — a frame the grid does not count,
// never a wrong label.
function angleFromYaw(yaw) {
  const v = Number(yaw);
  if (yaw == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a <= 20) return 'front';
  if (a <= 50) return 'three-quarter';
  return 'profile';
}
function framingFromFraction(fraction) {
  const v = Number(fraction);
  if (fraction == null || !Number.isFinite(v)) return null;
  if (v >= 0.10) return 'close';
  if (v >= 0.025) return 'medium';
  return 'full';
}
function qualityFromContrast(contrast) {
  const v = Number(contrast);
  if (contrast == null || !Number.isFinite(v)) return null;
  return v >= 0.20 ? 'hard' : 'soft';
}

async function ingest({ avatarId, tenantId, frames = 60, keep = 40, sourcePath, isVideo = true, onProgress = () => {} }) {
  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, slug, name, mode FROM avatars WHERE id = $1 AND tenant_id = $2', [avatarId, tenantId]);
  const avatar = av[0];
  if (!avatar) throw new TwinIngestError('No such avatar in this workspace', 'NO_AVATAR');
  if (avatar.mode === 'synthetic') throw new TwinIngestError('A synthetic avatar has no footage to ingest', 'NOT_A_TWIN');

  const { rows: consent } = await pool.query(
    `SELECT c.id, c.video_url FROM consent_records c JOIN avatars a ON a.consent_record_id = c.id
      WHERE a.id = $1`, [avatarId]);
  if (!consent.length || !consent[0].video_url) {
    throw new TwinIngestError('No recorded consent to verify against. Capture consent first.', 'NO_CONSENT');
  }
  const record = consent[0];

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-ingest-'));
  try {
    onProgress('Reading your footage…');
    let framePaths;
    if (isVideo) framePaths = extractFrames(sourcePath, path.join(tmpRoot, 'frames'), frames);
    else framePaths = listImages(sourcePath);
    if (!framePaths.length) throw new TwinIngestError('No frames could be read from that footage.', 'NO_FRAMES');

    onProgress('Finding your face in the frames…');
    const embedder = new FaceEmbedder();
    const usable = [];
    for (const fp of framePaths) {
      try {
        const e = await embedder.embed(fp, {});
        if (e && Array.isArray(e.embedding)) usable.push({
          path: fp, emb: e.embedding,
          angle: angleFromYaw(e.yaw),
          framing: framingFromFraction(e.face_fraction),
          quality: qualityFromContrast(e.light_contrast),
        });
      } catch { /* skip frames with no/one-too-many faces */ }
    }
    if (!usable.length) throw new TwinIngestError('No usable face was found in the footage. Use clearer, front-facing video.', 'NO_FACE');

    onProgress('Checking it matches your consent video…');
    let consentEmb = null;
    const vpath = await fetchToFile(record.video_url, path.join(tmpRoot, 'consent-video'));
    const cf = oneFrame(vpath, path.join(tmpRoot, 'consent'));
    const ce = await embedder.embed(cf, {});
    consentEmb = ce && Array.isArray(ce.embedding) ? ce.embedding : null;
    if (!consentEmb) throw new TwinIngestError('No face found in the consent video. Re-record consent with your face visible.', 'CONSENT_NO_FACE');

    const sim = Consent.cosineSimilarity(consentEmb, meanVec(usable.map((u) => u.emb)));
    if (!Consent.isSamePerson(sim)) {
      throw new TwinIngestError(
        `The footage does not match the consent video (score ${sim.toFixed(2)}). ` +
        'A twin must be built from the same person who consented.', 'CONSENT_MISMATCH');
    }
    await pool.query(
      `UPDATE consent_records SET verified = TRUE, match_score = $2,
              verified_at = COALESCE(verified_at, NOW()) WHERE id = $1`,
      [record.id, Number(sim.toFixed(4))]);

    onProgress('Saving your training frames…');
    const kept = sample(usable, keep);
    const storage = createStorage();
    const batch = `twin-${Date.now().toString(36)}`;
    let n = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of kept) {
        const buf = fs.readFileSync(item.path);
        const base = `${String(n + 1).padStart(4, '0')}-twin-${path.basename(item.path)}`.replace(/[^A-Za-z0-9._-]/g, '_');
        const storageKey = await storeFrame(storage, { tenantId, avatarSlug: avatar.slug, filename: base, buf });
        await client.query(
          `INSERT INTO seed_candidates (avatar_id, filename, idx, angle, framing, quality, seed, storage_key, job_id, batch, kind)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,NULL,$8,'pool')
           ON CONFLICT (avatar_id, filename) DO UPDATE SET storage_key = EXCLUDED.storage_key,
             angle = EXCLUDED.angle, framing = EXCLUDED.framing, quality = EXCLUDED.quality`,
          [avatarId, base, n, item.angle || null, item.framing || null, item.quality || null, storageKey, batch]);
        n += 1;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new TwinIngestError(`Could not save the frames: ${e.message}`, 'WRITE');
    } finally { client.release(); }

    return { kept: n, matchScore: Number(sim.toFixed(4)), batch };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

module.exports = { ingest, TwinIngestError, angleFromYaw, framingFromFraction, qualityFromContrast };
