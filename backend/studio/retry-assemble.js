#!/usr/bin/env node
'use strict';
/**
 * Requeue the ASSEMBLE-side stages (assemble, copy, voice) of a shoot that
 * failed after its clips were rendered. These stages are free (no fal spend), so
 * re-running them salvages a reel without paying to regenerate the clips.
 *
 *   DB_NAME=rstudio_db node studio/retry-assemble.js --project 12
 *
 * Safe: it only touches server-side stages in a failed/blocked state, resets
 * their attempts and error, and the claim query already gates each on its
 * upstream deps being done — so assemble runs first, then copy.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require(path.join(__dirname, '..', 'src/config/db'));

const i = process.argv.indexOf('--project');
const pid = i > -1 ? Number(process.argv[i + 1]) : null;
if (!pid) { console.error('\n  usage: node studio/retry-assemble.js --project <id>\n'); process.exit(1); }

(async () => {
  const { rows: before } = await pool.query(
    `SELECT stage, status FROM render_jobs
      WHERE project_id = $1 AND stage IN ('assemble','copy','voice') ORDER BY step_index`, [pid]);
  console.log(`\n  #${pid} assemble-side stages:`, before.map((r) => `${r.stage}:${r.status}`).join(', ') || '(none)');

  const { rowCount } = await pool.query(
    `UPDATE render_jobs
        SET status = 'queued', attempts = 0, error = NULL, updated_at = NOW()
      WHERE project_id = $1
        AND stage IN ('assemble','copy','voice')
        AND status IN ('failed','blocked')`, [pid]);

  // The project row may have been left 'generating'; leave it — status is derived
  // from the jobs on the shoots list, and copy completing flips it to done.
  console.log(`  requeued ${rowCount} stage(s). The API's server runner will stitch, then caption.`);
  console.log('  Watch the shoot page; it should reach 100%.\n');
  await pool.end();
})().catch((e) => { console.error('retry failed:', e.message); process.exit(1); });
