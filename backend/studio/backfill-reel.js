#!/usr/bin/env node
'use strict';
/**
 * Backfill the downloadable `reel` asset for shoots whose assemble ran in
 * passthrough mode before that path recorded one. Points the asset at the
 * motion clip already in storage — no re-encode, no fal spend.
 *
 *   DB_NAME=rstudio_db node studio/backfill-reel.js --project 8
 *   DB_NAME=rstudio_db node studio/backfill-reel.js            # all done shoots missing a reel
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'src/config/db'));
const { createStorage } = require(path.join(__dirname, '..', 'src/services/studio/storageFactory'));

const argPid = (() => { const i = process.argv.indexOf('--project'); return i > -1 ? Number(process.argv[i + 1]) : null; })();
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
    if (hasReel.length) { continue; }

    const { rows: motion } = await pool.query(
      `SELECT id, shot_id, payload, result FROM render_jobs
        WHERE project_id=$1 AND stage='motion' AND status='done' ORDER BY id`, [proj.id]);
    const clips = motion.map((m) => firstKey(m.result)).filter(Boolean);
    if (!clips.length) {
      console.log(`  #${proj.id}: no finished motion clip — dumping motion jobs:`);
      for (const m of motion) console.log(`    job#${m.id} shot=${m.shot_id} result=${JSON.stringify(m.result).slice(0,400)}`);
      if (!motion.length) {
        const all = (await pool.query(`SELECT id, stage, status FROM render_jobs WHERE project_id=$1 AND stage='motion'`, [proj.id])).rows;
        console.log(`    (no done motion jobs; all motion jobs: ${JSON.stringify(all)})`);
      }
      continue;
    }
    if (clips.length > 1) { console.log(`  #${proj.id}: ${clips.length} clips (stitched reel expected) — skip, not a passthrough`); continue; }

    const clipKey = clips[0];
    const reelUrl = /^https?:\/\//i.test(clipKey) ? clipKey : storage.readUrl(clipKey);
    const pl = motion[0].payload || {};
    await pool.query(
      `INSERT INTO studio_assets
         (tenant_id, project_id, shot_id, avatar_id, lora_id, kind, storage_url, provider, seconds, qc_status, selected)
       VALUES ($1,$2,$3,$4,$5,'reel',$6,'fal',$7,'passed',true)`,
      [proj.tenant_id, proj.id, motion[0].shot_id || null, proj.avatar_id || null, pl.lora_id || null, reelUrl, pl.clip_seconds || null]
    );
    console.log(`  #${proj.id}: reel asset created → ${reelUrl}`);
    made += 1;
  }
  console.log(`\n  Done. ${made} reel asset(s) backfilled.\n`);
  await pool.end();
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
