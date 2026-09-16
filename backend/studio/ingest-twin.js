#!/usr/bin/env node
'use strict';

/**
 * Ingest a digital twin's training material — and verify consent against it.
 *
 *   node studio/ingest-twin.js --avatar <id> --video ~/me.mp4          # dry run
 *   node studio/ingest-twin.js --avatar <id> --video ~/me.mp4 --yes    # ingest
 *   node studio/ingest-twin.js --avatar <id> --images ~/twin-photos --yes
 *   --frames N   frames to sample from a video   (default 60)
 *   --keep   M   max frames to keep for training (default 40)
 *
 * A synthetic avatar GENERATES its training frames from a text identity. A twin
 * has none to generate — it is a real person, so the frames come from that
 * person's own footage. This extracts frames (ffmpeg), keeps the ones with a
 * single clear face (insightface), and — the meaningful consent check — matches
 * the person in the footage against the recorded CONSENT video. Only if they are
 * the same person are the frames written into `seed_candidates` (the same shape
 * the synthetic pipeline uses) and the consent marked verified. So the existing
 * cull screen and `studio/train.js` then work on a twin unchanged.
 *
 * GATED ON CONSENT. Refuses unless a consent record with a captured video exists
 * (recorded in-app first, on the twin's clone page). The same-person match is
 * done HERE, against the actual training footage, because that is the comparison
 * that proves the consenter is the subject.
 *
 * Runs on the machine with the database + insightface + ffmpeg (the Mac), like
 * train.js — the footage stays local; nothing goes to fal here.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const { createStorage } = require(path.join(ROOT, 'src/services/studio/storageFactory'));
const { FaceEmbedder } = require(path.join(ROOT, 'worker/faceEmbed'));
const Consent = require(path.join(ROOT, 'src/services/studio/consent'));

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const AVATAR = Number(flag('--avatar'));
const VIDEO  = flag('--video');
const IMAGES = flag('--images');
const FRAMES = Math.max(10, Math.min(300, Number(flag('--frames', '60')) || 60));
const KEEP   = Math.max(8, Math.min(120, Number(flag('--keep', '40')) || 40));
const APPLY  = argv.includes('--yes');

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

function ffprobeDuration(p) {
  try {
    const out = execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', p],
      { encoding: 'utf8' });
    return parseFloat(String(out).trim()) || 0;
  } catch { return 0; }
}

function extractFrames(video, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const dur = ffprobeDuration(video);
  const rate = dur > 0 ? FRAMES / dur : 1;
  try {
    execFileSync('ffmpeg',
      ['-y', '-i', video, '-vf', `fps=${rate.toFixed(4)}`, '-qscale:v', '3',
       path.join(outDir, 'f%04d.jpg')], { stdio: 'ignore' });
  } catch (e) {
    die(`ffmpeg could not read ${video}. Is it a video file, and is ffmpeg installed? (${e.message})`);
  }
  return fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg'))
    .sort().map((f) => path.join(outDir, f));
}

function oneFrame(video, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'consent-frame.jpg');
  execFileSync('ffmpeg', ['-y', '-ss', '0.5', '-i', video, '-frames:v', '1', out], { stdio: 'ignore' });
  return out;
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
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
  if (!fs.existsSync(dir)) die(`No such folder: ${dir}`);
  return fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f))
    .sort().map((f) => path.join(dir, f));
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
  if (!res.ok) throw new Error(`storage PUT failed HTTP ${res.status}`);
  return t.key;
}

(async () => {
  if (!AVATAR) die('Pass --avatar <id>.');
  if (!VIDEO && !IMAGES) die('Pass --video <file> or --images <folder>.');

  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, slug, name, mode FROM avatars WHERE id = $1', [AVATAR]);
  if (!av.length) die(`No avatar #${AVATAR}.`);
  const avatar = av[0];
  if (avatar.mode === 'synthetic') {
    die(`${avatar.name} is synthetic — it has no real person to ingest. This is for a twin.`);
  }

  // A consent RECORD with a captured video must exist. It is VERIFIED here.
  const { rows: consent } = await pool.query(
    `SELECT c.id, c.video_url, c.verified FROM consent_records c
       JOIN avatars a ON a.consent_record_id = c.id
      WHERE a.id = $1`, [AVATAR]);
  if (!consent.length || !consent[0].video_url) {
    die(`${avatar.name} has no recorded consent yet. Capture consent in the app first `
      + `(the twin's clone page), then re-run.`);
  }
  const record = consent[0];

  console.log(`\n  ${avatar.name} (#${avatar.id}, twin) — consent recorded${record.verified ? ' (already verified)' : ''}`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-ingest-'));
  let frames;
  if (VIDEO) {
    console.log(`  Source: video ${VIDEO}`);
    frames = extractFrames(VIDEO, path.join(tmpRoot, 'frames'));
    console.log(`  Extracted ${frames.length} frames (target ${FRAMES}).`);
  } else {
    console.log(`  Source: images ${IMAGES}`);
    frames = listImages(IMAGES);
    console.log(`  Found ${frames.length} images.`);
  }
  if (!frames.length) die('No frames to work with.');

  if (!APPLY) {
    console.log(`\n  Dry run. Would embed each frame, keep up to ${KEEP} with a single clear face,`);
    console.log('  verify the footage matches your consent video, then register them for culling.');
    console.log('  Re-run with --yes to ingest.\n');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    await pool.end();
    return;
  }

  console.log('\n  Embedding frames (insightface)…');
  const embedder = new FaceEmbedder();
  const usable = [];
  for (const fp of frames) {
    try {
      const e = await embedder.embed(fp, {});
      if (e && Array.isArray(e.embedding)) usable.push({ path: fp, emb: e.embedding });
    } catch { /* no face / two faces / unreadable — skip */ }
  }
  console.log(`  ${usable.length}/${frames.length} frames have a usable single face.`);
  if (!usable.length) die('No frame had a usable face. Use clearer, front-facing footage.');

  // ── Consent check: is the person in the footage the person who consented? ──
  let consentEmb = null;
  try {
    const vpath = await fetchToFile(record.video_url, path.join(tmpRoot, 'consent-video'));
    const frame = oneFrame(vpath, path.join(tmpRoot, 'consent'));
    const ce = await embedder.embed(frame, {});
    consentEmb = ce && Array.isArray(ce.embedding) ? ce.embedding : null;
  } catch (e) {
    die(`Could not read the consent video to verify it: ${e.message}`);
  }
  if (!consentEmb) die('No face found in the consent video. Re-record consent with your face clearly visible.');

  const footageMean = meanVec(usable.map((u) => u.emb));
  const sim = Consent.cosineSimilarity(consentEmb, footageMean);
  const same = Consent.isSamePerson(sim);
  console.log(`  Consent match: ${sim.toFixed(4)} (needs >= ${Consent.SAME_PERSON_THRESHOLD}) -> ${same ? 'same person ✓' : 'MISMATCH'}`);
  if (!same) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    die(`The footage does not match the consent video (score ${sim.toFixed(4)}). `
      + `A twin must be built from the same person who consented. Nothing was written.`);
  }
  await pool.query(
    `UPDATE consent_records SET verified = TRUE, match_score = $2,
            verified_at = COALESCE(verified_at, NOW()) WHERE id = $1`,
    [record.id, Number(sim.toFixed(4))]);
  console.log('  Consent verified against the footage. ✓');

  // ── Write the kept frames as training candidates ──
  const kept = sample(usable, KEEP);
  const storage = createStorage();
  const batch = `twin-${Date.now().toString(36)}`;
  let n = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of kept) {
      const buf = fs.readFileSync(item.path);
      const base = `${String(n + 1).padStart(4, '0')}-twin-${path.basename(item.path)}`.replace(/[^A-Za-z0-9._-]/g, '_');
      const storageKey = await storeFrame(storage, {
        tenantId: avatar.tenant_id, avatarSlug: avatar.slug, filename: base, buf,
      });
      await client.query(
        `INSERT INTO seed_candidates
           (avatar_id, filename, idx, angle, framing, quality, seed, storage_key, job_id, batch, kind)
         VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,$4,NULL,$5,'pool')
         ON CONFLICT (avatar_id, filename) DO UPDATE SET storage_key = EXCLUDED.storage_key`,
        [avatar.id, base, n, storageKey, batch]);
      n += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    die(`Ingest failed, rolled back: ${e.message}`);
  } finally {
    client.release();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n  Ingested ${n} training candidates (batch ${batch}).`);
  console.log('  Next: cull them on the face screen (keep the ones that are clearly them),');
  console.log(`  then train:  node studio/train.js --avatar ${avatar.id}\n`);
  await pool.end();
})().catch((e) => die(e.message));
