#!/usr/bin/env node
'use strict';
/**
 * Audit a shoot end to end: every render job's status/error, every frame's QC
 * verdict + similarity, and the calibration baselines it is judged against.
 *
 *   DB_NAME=rstudio_db node studio/diag-shoot.js            # latest project
 *   DB_NAME=rstudio_db node studio/diag-shoot.js --project 7
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'src/config/db'));

const argPid = (() => { const i = process.argv.indexOf('--project'); return i > -1 ? Number(process.argv[i + 1]) : null; })();
const short = (s, n = 400) => (s == null ? '' : String(s).replace(/\s+/g, ' ').slice(0, n));

(async () => {
  const db = process.env.DB_NAME || '(default)';
  const { rows: [{ cd }] } = await pool.query('SELECT current_database() cd');
  console.log(`\n  DB: ${cd}  (DB_NAME=${db})`);

  const proj = argPid
    ? (await pool.query('SELECT * FROM studio_projects WHERE id=$1', [argPid])).rows[0]
    : (await pool.query('SELECT * FROM studio_projects ORDER BY id DESC LIMIT 1')).rows[0];
  if (!proj) { console.log('  No projects.'); await pool.end(); return; }

  console.log(`\n  Project #${proj.id} "${proj.title}"  kind=${proj.kind}  status=${proj.status}  avatar=${proj.avatar_id}`);
  console.log(`  brief: ${short(JSON.stringify(proj.brief), 500)}`);

  const { rows: jobs } = await pool.query(
    `SELECT id, stage, status, attempts, runner, step_index, shot_id, left(error,500) AS error
       FROM render_jobs WHERE project_id=$1 ORDER BY step_index, id`, [proj.id]);
  console.log(`\n  ── render_jobs (${jobs.length}) ──`);
  for (const j of jobs) {
    console.log(`  #${j.id} [${j.stage}] ${j.status} att=${j.attempts} runner=${j.runner} shot=${j.shot_id ?? '-'}`);
    if (j.error) console.log(`        error: ${short(j.error, 480)}`);
  }

  const { rows: assets } = await pool.query(
    `SELECT id, shot_id, kind, candidate_index, qc_status, qc_reason, face_similarity, selected, left(storage_url,80) AS url
       FROM studio_assets WHERE project_id=$1 ORDER BY shot_id, kind, candidate_index`, [proj.id]);
  console.log(`\n  ── studio_assets (${assets.length}) ──`);
  for (const a of assets) {
    console.log(`  #${a.id} shot=${a.shot_id} ${a.kind} cand=${a.candidate_index} qc=${a.qc_status||'-'} reason=${a.qc_reason||'-'} sim=${a.face_similarity??'-'} selected=${a.selected}`);
  }

  const { rows: shots } = await pool.query(
    `SELECT id, seq, framing, light_direction, light_quality, expression_key, expression_intensity
       FROM studio_shots WHERE scene_id IN (SELECT id FROM studio_scenes WHERE project_id=$1) ORDER BY seq`, [proj.id]);
  console.log(`\n  ── shots (${shots.length}) ──`);
  for (const s of shots) console.log(`  shot#${s.id} seq=${s.seq} framing=${s.framing} light=${s.light_direction}/${s.light_quality} expr=${s.expression_key}/${s.expression_intensity}`);

  const { rows: lora } = await pool.query(
    `SELECT id, active, (face_embedding_mean IS NOT NULL) AS has_mean, network_rank
       FROM avatar_loras WHERE avatar_id=$1 ORDER BY active DESC, id DESC`, [proj.avatar_id]);
  console.log(`\n  ── avatar_loras ──`);
  for (const l of lora) console.log(`  lora#${l.id} active=${l.active} has_mean=${l.has_mean} rank=${l.network_rank}`);

  const activeLora = lora.find((l) => l.active);
  if (activeLora) {
    const { rows: bl } = await pool.query(
      `SELECT preset_key, framing, expected_similarity, tolerance, sample_count
         FROM expression_baselines WHERE avatar_id=$1 AND lora_id=$2 ORDER BY preset_key, framing`,
      [proj.avatar_id, activeLora.id]);
    console.log(`\n  ── expression_baselines for lora#${activeLora.id} (${bl.length}) ──`);
    for (const b of bl) console.log(`  ${b.preset_key}/${b.framing}: expected=${b.expected_similarity} tol=${b.tolerance} n=${b.sample_count}  floor=${(Number(b.expected_similarity)-Number(b.tolerance)).toFixed(4)}`);
  }
  console.log('');
  await pool.end();
})().catch((e) => { console.error('diag failed:', e.message); process.exit(1); });
