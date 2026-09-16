#!/usr/bin/env node
'use strict';

/**
 * Read-only: what is Aanya's likeness gate actually made of, cell by cell.
 *
 *   node studio/calibration-report.js
 *
 * The QC floor for a shot is Math.min(calibratedFloor, IDENTITY_FLOOR), where
 * calibratedFloor = expected - tolerance and IDENTITY_FLOOR is 0.68 (env
 * STUDIO_QC_IDENTITY_FLOOR). So for every measured cell there are two regimes:
 *
 *   - calibratedFloor <= 0.68  → CALIBRATION governs (the gate is the per-cell
 *     measurement; 0.68 is just a backstop). This is what we want.
 *   - calibratedFloor  > 0.68  → the CAP governs (0.68 does all the work; the
 *     tight, low-variance calibration is being ignored). This is the "crutch".
 *
 * And a framing with NO baseline for a preset falls back to that preset's
 * average over the framings that DO exist — a wide shot judged by a medium
 * baseline scores too low and is saved only by the 0.68 cap. This report shows
 * which cells are missing, which are governed by calibration, and which lean on
 * the cap — the whole point of T34.
 *
 * Run it on the machine with the database (localhost Postgres), read-only.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const Calibration = require(path.join(ROOT, 'src/services/studio/calibration'));

const SLUG = process.argv.includes('--avatar')
  ? process.argv[process.argv.indexOf('--avatar') + 1]
  : 'aanya-kapoor';
const IDENTITY_FLOOR = Number(process.env.STUDIO_QC_IDENTITY_FLOOR) || 0.68;
const FRAMINGS = Calibration.FRAMINGS; // ['close','medium','wide']

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };
const f4  = (v) => (v === null || v === undefined ? '   —  ' : Number(v).toFixed(4));

(async () => {
  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, name, slug FROM avatars WHERE slug = $1', [SLUG]);
  if (!av.length) die(`No avatar with slug "${SLUG}".`);
  const avatar = av[0];

  const { rows: loras } = await pool.query(
    'SELECT id, version, active FROM avatar_loras WHERE avatar_id = $1 ORDER BY version DESC', [avatar.id]);
  if (!loras.length) die(`${avatar.name} has no trained LoRA.`);
  const lora = loras.find((l) => l.active) || loras[0];

  // The vocabulary version lives on the look profile, not the lora row.
  const { rows: lp } = await pool.query(
    'SELECT vocabulary_version FROM look_profiles WHERE avatar_id = $1', [avatar.id]);
  const vv = (lp[0] && lp[0].vocabulary_version) || 1;

  let presets = [];
  try {
    presets = await Calibration.expressible(avatar.tenant_id, { vocabularyVersion: vv });
  } catch (e) { /* fall back to whatever baselines exist */ }
  const presetKeys = presets.length
    ? presets.map((p) => p.key)
    : null; // null → derive from baselines

  const { rows: base } = await pool.query(
    `SELECT preset_key, framing, expected_similarity::float AS expected,
            tolerance::float AS tolerance, sample_count, calibrated_at
       FROM expression_baselines WHERE avatar_id = $1 AND lora_id = $2
      ORDER BY preset_key, framing`,
    [avatar.id, lora.id]);

  const byCell = new Map();
  for (const r of base) byCell.set(`${r.preset_key}:${r.framing}`, r);
  const keys = presetKeys || [...new Set(base.map((r) => r.preset_key))];

  console.log(`\n  ${avatar.name} (#${avatar.id}) — LoRA v${lora.version}${lora.active ? ' (active)' : ' (inactive)'}`);
  console.log(`  IDENTITY_FLOOR (the cap) = ${IDENTITY_FLOOR}   framings = ${FRAMINGS.join(', ')}\n`);
  console.log('  expression        framing   expected  tol     calibFloor  governs        n   measured');
  console.log('  ' + '-'.repeat(88));

  let cap = 0, calib = 0, missing = 0;
  for (const key of keys) {
    for (const framing of FRAMINGS) {
      const r = byCell.get(`${key}:${framing}`);
      if (!r) {
        missing += 1;
        console.log(`  ${key.padEnd(16)}  ${framing.padEnd(7)}   ${'—'.padStart(8)}  ${'—'.padStart(6)}  ${'—'.padStart(9)}   ${'MISSING'.padEnd(13)}  —   —`);
        continue;
      }
      const calibFloor = r.expected - r.tolerance;
      const governs = calibFloor <= IDENTITY_FLOOR ? 'calibration' : 'CAP 0.68 (crutch)';
      if (calibFloor <= IDENTITY_FLOOR) calib += 1; else cap += 1;
      const when = r.calibrated_at ? new Date(r.calibrated_at).toISOString().slice(0, 10) : '—';
      console.log(`  ${key.padEnd(16)}  ${framing.padEnd(7)}   ${f4(r.expected)}  ${f4(r.tolerance)}  ${f4(calibFloor)}   ${governs.padEnd(13)}  ${String(r.sample_count).padStart(2)}  ${when}`);
    }
  }

  console.log('  ' + '-'.repeat(88));
  console.log(`\n  Cells: ${calib} governed by calibration · ${cap} leaning on the 0.68 CAP · ${missing} MISSING (fall back to the preset average across framings)`);

  const { rows: cost } = await pool.query(
    `SELECT COUNT(*)::int AS frames, COALESCE(SUM(cost_cents),0)::int AS cents
       FROM render_jobs WHERE stage = 'calib_still' AND tenant_id = $1
        AND payload->>'lora_id' = $2 AND status = 'completed'`,
    [avatar.tenant_id, String(lora.id)]);
  console.log(`  Calibration frames rendered so far: ${cost[0].frames} (supplier cost recorded: $${(cost[0].cents / 100).toFixed(2)})`);

  const missingFramings = FRAMINGS.filter((fr) => keys.every((k) => !byCell.has(`${k}:${fr}`)));
  if (missingFramings.length) {
    console.log(`\n  Framings with NO baselines at all: ${missingFramings.join(', ')}`);
    console.log(`  → recalibrate them:  node studio/recalibrate-aanya.js --framings ${missingFramings.join(',')}`);
  } else if (cap > 0 || missing > 0) {
    console.log(`\n  → some cells lean on the cap or are missing; see recalibrate-aanya.js`);
  } else {
    console.log(`\n  Every measurable cell is governed by calibration. Nothing to recalibrate.`);
  }
  console.log('');
  await pool.end();
})().catch((e) => die(e.message));
