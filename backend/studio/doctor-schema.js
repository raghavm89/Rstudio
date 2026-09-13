#!/usr/bin/env node
'use strict';

/**
 * Which studio migrations have been applied, and what is missing if not.
 *
 * The project HAS a runner — `npm run db:migrate`, reading `src/db/migrations/`
 * and recording each file in `schema_migrations`. An earlier version of this
 * script probed for columns and tables to infer what had run, which was a worse
 * answer to a question the database already answers exactly. It now reads the
 * record.
 *
 * What it adds over `db:migrate` is the consequence: a migration that has not
 * run does not fail at migrate time, it fails at USE time, deep inside a request,
 * as a 500 with a Postgres error code. Knowing that `034` is the difference
 * between working sign-up and a 500 is the part worth printing.
 *
 *     node studio/doctor-schema.js
 *
 * Reads only.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));

/** What breaks when a given migration has not run. */
const BREAKS = {
  '031_studio_job_dependencies.sql': 'multi-step shoots — the DAG has no edges',
  '032_studio_cost_precision.sql':   'cost accounting rounds every fractional cent',
  '033_drop_reference_mode.sql':     'nothing at runtime — but `reference` mode is meant to be unbuildable',
  '034_signup_audience.sql':         'POST /api/auth/register — 500, and no Studio sign-up gets a workspace',
  '035_oauth_handoff.sql':           'Google/GitHub sign-in — the callback cannot mint a handoff code',
};

const fs = require('fs');
const MIGRATIONS_DIR = path.join(ROOT, 'src', 'db', 'migrations');

(async () => {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = onDisk.filter((f) => !applied.has(f));

  console.log('\nMigrations\n');
  console.log(`  on disk   ${onDisk.length}   (${path.relative(ROOT, MIGRATIONS_DIR)})`);
  console.log(`  applied   ${applied.size}`);

  // Files that live only in studio/migrations/ are invisible to the runner — the
  // exact mistake that made 034 look "written" while never having run.
  const studioDir = path.join(ROOT, 'studio', 'migrations');
  if (fs.existsSync(studioDir)) {
    const stray = fs.readdirSync(studioDir)
      .filter((f) => f.endsWith('.sql') && !onDisk.includes(f));
    if (stray.length) {
      console.log(`\n  ⚠ ${stray.length} migration(s) exist in studio/migrations/ but NOT in the`);
      console.log('    runner directory, so `npm run db:migrate` will never see them:');
      for (const f of stray) console.log(`      ${f}`);
      console.log('    Copy them into src/db/migrations/ first.');
    }
  }

  if (!pending.length) { console.log('\n  Up to date.\n'); return; }

  console.log('\n  Pending:\n');
  for (const f of pending) {
    console.log(`    ${f}`);
    if (BREAKS[f]) console.log(`      without it: ${BREAKS[f]}`);
  }
  console.log('\n  Apply them:  npm run db:migrate\n');
})().catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
