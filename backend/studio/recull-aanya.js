#!/usr/bin/env node
'use strict';

/**
 * Reconcile Aanya's seed_candidates to the balanced 18-frame keep set.
 *
 * WHY THIS EXISTS
 * ---------------
 * `train.js` reads the kept set from the DATABASE (`seed_candidates`), not from
 * `cull-state.json`. The `cull.js` importer only fills rows whose verdict IS
 * NULL — it will never overwrite a decision already made — so editing
 * `cull-state.json` after the first cull does NOT change what training sees.
 *
 * This script makes the DB match the new balanced set: exactly these 18 frames
 * KEEP, everything else for this avatar REJECT. It is the DB equivalent of
 * re-culling on the face screen.
 *
 *     node studio/recull-aanya.js            # dry run — show what would change
 *     node studio/recull-aanya.js --yes      # apply
 *
 * Safe: it refuses unless all 18 target filenames are found in seed_candidates,
 * and it prints before/after counts. Run it on the machine with the database
 * (localhost Postgres), same as train.js / cull.js.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));

const SLUG = 'aanya-kapoor';
const APPLY = process.argv.includes('--yes');

// The balanced set: 2 per cell across all 9 framing x angle cells, one soft + one hard.
const KEEP = [
  '0001-close-front-soft-704316489.png',
  '0004-close-front-hard-383351537.png',
  '0031-close-three-quarter-soft-969207289.png',
  '0034-close-three-quarter-hard-1450901883.png',
  '0045-close-profile-soft-88297959.png',
  '0046-close-profile-hard-1246551568.png',
  '0047-medium-front-soft-1700564564.png',
  '0048-medium-front-hard-1505362413.png',
  '0049-medium-three-quarter-soft-1369900762.png',
  '0050-medium-three-quarter-hard-1268554119.png',
  '0051-medium-profile-soft-686528613.png',
  '0052-medium-profile-hard-1644783362.png',
  '0053-full-front-soft-1485948964.png',
  '0081-full-front-hard-595585565.png',
  '0095-full-three-quarter-soft-1149316946.png',
  '0096-full-three-quarter-hard-1781237223.png',
  '0097-full-profile-soft-645706257.png',
  '0111-full-profile-hard-766877161.png',
];

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

(async () => {
  const { rows: av } = await pool.query('SELECT id, tenant_id, name FROM avatars WHERE slug = $1', [SLUG]);
  if (!av.length) die(`No avatar with slug "${SLUG}".`);
  const avatar = av[0];

  const { rows: present } = await pool.query(
    'SELECT filename FROM seed_candidates WHERE avatar_id = $1 AND filename = ANY($2::text[])',
    [avatar.id, KEEP]
  );
  const found = new Set(present.map((r) => r.filename));
  const missing = KEEP.filter((f) => !found.has(f));
  if (missing.length) {
    die(`${missing.length} of 18 target frames are not in seed_candidates for ${avatar.name} (#${avatar.id}):\n      `
      + missing.join('\n      ')
      + '\n\n    Register candidates first:  npm run studio:cull -- --avatar ' + avatar.id);
  }

  const before = await pool.query(
    "SELECT COALESCE(verdict,'(null)') v, COUNT(*)::int c FROM seed_candidates WHERE avatar_id = $1 GROUP BY 1 ORDER BY 1",
    [avatar.id]
  );
  console.log(`\n  ${avatar.name} (#${avatar.id}) — seed_candidates before:`);
  before.rows.forEach((r) => console.log(`    ${r.v.padEnd(8)} ${r.c}`));
  console.log(`\n  Target: 18 keep, the rest reject.`);

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --yes to apply.\n');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE seed_candidates SET verdict = 'keep', decided_at = NOW() WHERE avatar_id = $1 AND filename = ANY($2::text[])",
      [avatar.id, KEEP]
    );
    await client.query(
      "UPDATE seed_candidates SET verdict = 'reject', decided_at = NOW() WHERE avatar_id = $1 AND NOT (filename = ANY($2::text[]))",
      [avatar.id, KEEP]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    die(`Update failed, rolled back: ${e.message}`);
  } finally {
    client.release();
  }

  const after = await pool.query(
    "SELECT COALESCE(verdict,'(null)') v, COUNT(*)::int c FROM seed_candidates WHERE avatar_id = $1 GROUP BY 1 ORDER BY 1",
    [avatar.id]
  );
  console.log(`\n  Applied. seed_candidates after:`);
  after.rows.forEach((r) => console.log(`    ${r.v.padEnd(8)} ${r.c}`));
  console.log('\n  Now:  node studio/train.js --avatar ' + avatar.id + '        # price it, then --yes to train\n');
  await pool.end();
})().catch((e) => die(e.message));
