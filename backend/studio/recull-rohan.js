#!/usr/bin/env node
'use strict';

/**
 * Set Rohan's seed_candidates to a balanced, identity-verified 18-frame keep set.
 *
 * The DB equivalent of culling on the face screen: exactly these 18 frames KEEP,
 * everything else REJECT for rohan-mehra. The 18 are two per framing×angle cell
 * (one soft, one hard) spanning the whole coverage grid — front/three-quarter/
 * profile × close/medium/full × soft/hard — and each was eyeballed to be
 * unmistakably the same lean man (the one frame that drifted muscular,
 * 0011-medium-profile-soft, was swapped for the lean 0029).
 *
 *   node studio/recull-rohan.js          # dry run
 *   node studio/recull-rohan.js --yes    # apply
 *
 * Register the pool first:  node studio/cull.js --avatar 6
 * Runs on the machine with the database (localhost Postgres), like train.js.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));

const SLUG = 'rohan-mehra';
const APPLY = process.argv.includes('--yes');

// Two per framing×angle cell, one soft + one hard, all verified lean/consistent.
const KEEP = [
  '0001-close-front-soft-627191371.png',
  '0002-close-front-hard-539146706.png',
  '0003-close-three-quarter-soft-1634789064.png',
  '0004-close-three-quarter-hard-617443275.png',
  '0005-close-profile-soft-149164186.png',
  '0006-close-profile-hard-1900818874.png',
  '0007-medium-front-soft-1265754725.png',
  '0008-medium-front-hard-631431487.png',
  '0009-medium-three-quarter-soft-520754915.png',
  '0010-medium-three-quarter-hard-1856865960.png',
  '0029-medium-profile-soft-2118919065.png',
  '0012-medium-profile-hard-2122790042.png',
  '0013-full-front-soft-1844967580.png',
  '0014-full-front-hard-1777706485.png',
  '0015-full-three-quarter-soft-1552923825.png',
  '0016-full-three-quarter-hard-115158119.png',
  '0017-full-profile-soft-299830167.png',
  '0018-full-profile-hard-1109232042.png',
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
    die(`${missing.length} of ${KEEP.length} target frames are not in seed_candidates for ${avatar.name} (#${avatar.id}):\n      `
      + missing.join('\n      ')
      + '\n\n    Register candidates first:  node studio/cull.js --avatar ' + avatar.id);
  }

  const before = await pool.query(
    "SELECT COALESCE(verdict,'(null)') v, COUNT(*)::int c FROM seed_candidates WHERE avatar_id = $1 GROUP BY 1 ORDER BY 1",
    [avatar.id]
  );
  console.log(`\n  ${avatar.name} (#${avatar.id}) — seed_candidates before:`);
  before.rows.forEach((r) => console.log(`    ${r.v.padEnd(8)} ${r.c}`));
  console.log(`\n  Target: ${KEEP.length} keep, the rest reject.`);

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
