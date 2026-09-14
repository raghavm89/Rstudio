#!/usr/bin/env node
'use strict';
/**
 * Backfill the downloadable `reel` asset for shoots whose assemble finished
 * before that path recorded a studio_assets row (stitched OR passthrough).
 * Points the asset at the reel already in storage — no re-encode, no fal spend.
 *
 *   DB_NAME=rstudio_db node studio/backfill-reel.js --project 12
 *   DB_NAME=rstudio_db node studio/backfill-reel.js            # all motion shoots missing a reel
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'src/config/db'));
const { createStorage } = require(path.join(__dirname, '..', 'src/services/studio/storageFactory'));

const i = process.argv.indexOf('--project');
const argPid = i > -1 ? Number(process.argv[i + 1]) : null;
const firstKey = (r) => { const a = r && Array.isArray(r.assets) && r.assets[0]; return a ? (a.key || a.url || null) : null; };

(async () => {
  const storage = createStorage();
  const projects = argPid
    ? (await pool.query(`SELECT id, tenant_id, avatar_id FROM studio_projects WHERE id=$1`, [argPid])).rows
    : (await pool.query(`SELECT id, tenant_id, avatar_id FROM studio_projects WHERE kind IN ('reel','short','longform')`)).rows;

  let made = 0;
  for (const proj of projects) {
    const { rows: hasReel } = await pool.query(
      `SELECT 1 FROM studio_assets WHERE project_id=$1 AND kind IN ('reel','clip','short','longform') AND storage_url IS NOT NULL LIMIT 1`, [proj.id]);
    if (hasReel.length) continue;

    // Prefer the assembled reel's own key (covers stitched multi-clip reels).
    const { rows: asm } = await pool.query(
      `SELECT result FROM render_jobs WHERE project_id=$1 AND stage='assemble' AND status='done' ORDER BY id DESC LIMIT 1`, [proj.id]);
    let reelKey = asm[0] && asm[0].result && asm[0].result.video_key;
    let shotId = null, loraId = null;

    if (!reelKey) {
      // Fall back to a single motion clip (a passthrough that never recorded).
      const { rows: motion } = await pool.query(
        `SELECT shot_id, payload, result FROM render_jobs WHERE project_id=$1 AND stage='motion' AND status='done' ORDER BY id`, [proj.id]);
      const clips = motion.map((m) => firstKey(m.result)).filter(Boolean);
      if (clips.length === 1) { reelKey = clips[0]; shotId = motion[0].shot_id; loraId = motion[0].payload && motion[0].payload.lora_id; }
      else if (clips.length > 1) { console.log(`  #${proj.id}: ${clips.length} clips but no assemble video_key — skip (re-run assemble)`); continue; }
      else { console.log(`  #${proj.id}: no finished reel/clip — skip`); continue; }
    }

    const reelUrl = /^https?:\/\//i.test(reelKey) ? reelKey : storage.readUrl(reelKey);
    await pool.query(
      `INSERT INTO studio_assets
         (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, qc_status, selected)
       VALUES ($1,$2,$3,$4,$5,'reel',$6,'ffmpeg','passed',true)`,
      [proj.tenant_id, proj.id, shotId, proj.avatar_id || null, loraId, reelUrl]);
    console.log(`  #${proj.id}: reel asset created -> ${reelUrl}`);
    made += 1;
  }
  console.log(`\n  Done. ${made} reel asset(s) backfilled.\n`);
  await pool.end();
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
