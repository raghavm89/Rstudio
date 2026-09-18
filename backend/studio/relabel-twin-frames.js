#!/usr/bin/env node
'use strict';

/**
 * Relabel an AI-clone's existing seed frames by head pose.
 *
 * The coverage gate reads each frame's angle/framing/quality. Twin frames used
 * to be stored with all three NULL, so the gate reported a coverage hole on
 * EVERY clone — even when the footage did span the angles. The ingest is fixed
 * to label new frames from insightface pose; this backfills the frames that were
 * already ingested, so a clone stuck on a phantom "coverage hole" can be seen for
 * what it really is: pass if the angles are present, or an honest "add a profile"
 * if they are not.
 *
 * Runs where the DB + insightface live (the Mac).
 *
 *   node studio/relabel-twin-frames.js --avatar tinkle
 *   node studio/relabel-twin-frames.js --avatar 7 --tenant 1
 */

require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../src/config/db');
const { createStorage } = require('../src/services/studio/storageFactory');
const { FaceEmbedder } = require('../worker/faceEmbed');
const { angleFromYaw, framingFromFraction, qualityFromContrast } = require('../src/services/studio/twinIngest');
const Seed = require('../src/services/studio/seedCandidates');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function localPathFor(storage, key, tmpDir) {
  if (typeof storage.pathFor === 'function') {
    const full = storage.pathFor(key);
    if (fs.existsSync(full)) return { path: full, cleanup: false };
  }
  // S3 or a missing local file: fetch the readable URL to a temp file.
  const url = storage.readUrl(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read ${key} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(tmpDir, key.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.writeFileSync(out, buf);
  return { path: out, cleanup: true };
}

(async () => {
  const who = flag('avatar');
  if (!who) { console.error('Usage: node studio/relabel-twin-frames.js --avatar <id|slug> [--tenant N]'); process.exit(1); }
  const tenantArg = flag('tenant');

  const byId = /^\d+$/.test(String(who));
  const { rows: av } = await pool.query(
    `SELECT id, slug, name, mode, tenant_id FROM avatars WHERE ${byId ? 'id = $1' : 'slug = $1'}
       ${tenantArg ? 'AND tenant_id = $2' : ''} LIMIT 1`,
    tenantArg ? [byId ? Number(who) : who, Number(tenantArg)] : [byId ? Number(who) : who]
  );
  const avatar = av[0];
  if (!avatar) { console.error(`No avatar matching "${who}".`); process.exit(1); }
  console.log(`Avatar #${avatar.id} ${avatar.slug} (${avatar.name}) — mode ${avatar.mode}`);

  const { rows: frames } = await pool.query(
    `SELECT filename, storage_key, angle FROM seed_candidates
      WHERE avatar_id = $1 AND tenant_id = $2 AND kind = 'pool'
      ORDER BY idx NULLS LAST, filename`,
    [avatar.id, avatar.tenant_id]
  );
  if (!frames.length) { console.error('No pool frames to relabel.'); process.exit(1); }
  const missingKey = frames.filter((f) => !f.storage_key);
  if (missingKey.length) console.log(`  (${missingKey.length} frame(s) have no storage key and will be skipped)`);

  const storage = createStorage();
  const embedder = new FaceEmbedder();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relabel-'));

  let done = 0, failed = 0;
  const client = await pool.connect();
  try {
    for (const f of frames) {
      if (!f.storage_key) { failed += 1; continue; }
      let loc = null;
      try {
        loc = await localPathFor(storage, f.storage_key, tmpDir);
        const e = await embedder.embed(loc.path, {});
        const angle = angleFromYaw(e.yaw);
        const framing = framingFromFraction(e.face_fraction);
        const quality = qualityFromContrast(e.light_contrast);
        await client.query(
          `UPDATE seed_candidates SET angle = $3, framing = $4, quality = $5
             WHERE avatar_id = $1 AND filename = $2`,
          [avatar.id, f.filename, angle, framing, quality]
        );
        done += 1;
        process.stdout.write(`\r  relabelled ${done}/${frames.length}`);
      } catch (err) {
        failed += 1;
      } finally {
        if (loc && loc.cleanup) { try { fs.unlinkSync(loc.path); } catch (_) {} }
      }
    }
  } finally {
    client.release();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n  done: ${done} relabelled, ${failed} skipped/failed`);

  // Report the coverage the KEPT set now has.
  const { rows: kept } = await pool.query(
    `SELECT angle, framing, quality, batch FROM seed_candidates
      WHERE avatar_id = $1 AND tenant_id = $2 AND kind = 'pool' AND verdict = 'keep'`,
    [avatar.id, avatar.tenant_id]
  );
  const gaps = Seed.coverageGaps(kept);
  const byAngle = {};
  for (const k of kept) byAngle[k.angle || 'unlabelled'] = (byAngle[k.angle || 'unlabelled'] || 0) + 1;
  console.log(`\n  kept frames: ${kept.length}`);
  console.log(`  angles present: ${JSON.stringify(byAngle)}`);
  if (!gaps.length) {
    console.log('  ✅ coverage satisfied — "Use these photos" will now pass.');
  } else {
    console.log('  ⚠️  still short:');
    for (const g of gaps) console.log(`     ${g.label} — missing ${g.missing.join(', ')}`);
    console.log('  → the footage genuinely lacks these angles; add a head-turn clip via "Add footage".');
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
