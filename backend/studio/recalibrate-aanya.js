#!/usr/bin/env node
'use strict';

/**
 * Recalibrate Aanya on production-like frames — the T34 fix.
 *
 *   node studio/recalibrate-aanya.js --full            # dry run: full fresh recal, all 3 framings
 *   node studio/recalibrate-aanya.js --full --yes      # do it: deactivate, clear, re-queue
 *   node studio/recalibrate-aanya.js --activate        # dry run: is she ready to reactivate?
 *   node studio/recalibrate-aanya.js --activate --yes  # reactivate once every cell is measured
 *   node studio/recalibrate-aanya.js                   # (additive) queue only the MISSING framings, keep her live
 *   node studio/recalibrate-aanya.js --samples 8 --yes # 6..12 samples/cell
 *   node studio/recalibrate-aanya.js --lora 3 --yes    # target a specific LoRA id
 *                                                      # (a fresh LoRA has no baselines,
 *                                                      #  so this calibrates all 3 framings)
 *
 * WHY
 * ---
 * Aanya's LoRA was calibrated at MEDIUM framing only, on low-variance setup
 * renders. calibration-report.js shows the result: all 11 medium cells lean on
 * the 0.68 CAP (calibratedFloor 0.76-0.80) and 22 close/wide cells have no
 * baseline at all. So the QC floor Math.min(calibratedFloor, 0.68) is 100%
 * crutch: 0.68 does the gating, the measurement does nothing.
 *
 * --full REBUILDS the whole gate. Safe because Aanya has no published posts:
 *   1. deactivate her LoRA               (no shoots run mid-recal — fine pre-launch)
 *   2. delete the low-variance baselines (so every cell is measured afresh)
 *   3. cancel the old calib_still jobs   (releases their idempotency keys so the
 *                                         frames are re-bought, via submit's own
 *                                         retry path — see calibrationRun)
 *   4. queue close + medium + wide       (each cell's own varied samples: the
 *                                         NUISANCE plan spans 8 light/pose setups
 *                                         x 3 wardrobes x 5 locations)
 * The calibration chain records each baseline as its cell settles. When every
 * measurable preset has a baseline, run --activate --yes to bring her back.
 *
 * WHAT IT NEEDS (all on this machine)
 * -----------------------------------
 *   - the API running with the inline render worker (RUN_INLINE_WORKER on), so
 *     calib_still jobs actually render.
 *   - fal reachable (this machine renders; the Cowork VM can't).
 *   - calibration credits if the rate card charges them; if short it prints how
 *     many, and studio/grant-credits.js tops the tenant up.
 *
 * Watch it land with:  node studio/calibration-report.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const Calibration    = require(path.join(ROOT, 'src/services/studio/calibration'));
const CalibrationRun = require(path.join(ROOT, 'src/services/studio/calibrationRun'));
const LoraTraining   = require(path.join(ROOT, 'src/services/studio/loraTraining'));

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const SLUG     = flag('--avatar', 'aanya-kapoor');
const APPLY    = argv.includes('--yes');
const FULL     = argv.includes('--full');
const ACTIVATE = argv.includes('--activate');
const SAMPLES  = Math.max(6, Math.min(12, Number(flag('--samples', '6')) || 6));
const chosen   = flag('--framings');
const LORA_ID  = flag('--lora') ? Number(flag('--lora')) : null;

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

async function findLora() {
  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, name FROM avatars WHERE slug = $1', [SLUG]);
  if (!av.length) die(`No avatar with slug "${SLUG}".`);
  const avatar = av[0];
  const { rows: loras } = await pool.query(
    'SELECT id, version, active FROM avatar_loras WHERE avatar_id = $1 ORDER BY version DESC', [avatar.id]);
  const lora = LORA_ID
    ? loras.find((l) => l.id === LORA_ID)
    : (loras.find((l) => l.active) || loras[0]);
  if (!lora) die(LORA_ID ? `${avatar.name} has no LoRA #${LORA_ID}.` : `${avatar.name} has no trained LoRA.`);
  return { avatar, lora };
}

// ── Reactivate ──────────────────────────────────────────────────────────────
async function reactivate() {
  const { avatar, lora } = await findLora();
  const state = await Calibration.readiness(avatar.tenant_id, lora.id);
  console.log(`\n  ${avatar.name} (#${avatar.id}) — LoRA v${lora.version}${lora.active ? ' (active)' : ' (inactive)'}`);
  console.log(`  Calibrated presets: ${state.calibrated}/${state.measurable}   cells: ${state.cells}`);
  if (!state.ready) {
    console.log(`  Not ready to activate — still missing: ${state.missing.join(', ') || '(needs neutral)'}\n`);
    await pool.end();
    return;
  }
  if (lora.active) { console.log('  Already active. Nothing to do.\n'); await pool.end(); return; }
  if (!APPLY) { console.log('  Ready. Re-run with --yes to reactivate.\n'); await pool.end(); return; }
  await Calibration.finish(avatar.tenant_id, lora.id);
  console.log('  Reactivated. She can shoot again, now gated by the fresh per-framing calibration.\n');
  await pool.end();
}

// ── Full fresh recalibration ──────────────────────────────────────────────────
async function fullRecal() {
  const { avatar, lora } = await findLora();
  const framings = Calibration.FRAMINGS; // close, medium, wide

  const { rows: bc } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM expression_baselines WHERE lora_id = $1', [lora.id]);
  const { rows: jc } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM render_jobs
      WHERE stage = 'calib_still' AND payload->>'lora_id' = $1 AND status <> 'cancelled'`,
    [String(lora.id)]);

  // What a fresh, empty calibration would buy, priced.
  const preview = await CalibrationRun.preview(avatar.tenant_id, lora.id, { framings, samples: SAMPLES });
  // preview subtracts cells that still have baselines; add them back for the
  // full picture, because --yes deletes those baselines first.
  const presets = await Calibration.expressible(avatar.tenant_id);
  const totalCells  = presets.length * framings.length;
  const totalFrames = totalCells * SAMPLES;

  console.log(`\n  ${avatar.name} (#${avatar.id}) — LoRA v${lora.version}${lora.active ? ' (active)' : ' (inactive)'}`);
  console.log(`  FULL fresh recalibration across: ${framings.join(', ')}   samples/cell: ${SAMPLES}\n`);
  console.log('  This will:');
  console.log(`    1. deactivate the LoRA`);
  console.log(`    2. delete ${bc[0].n} existing baseline(s)`);
  console.log(`    3. cancel ${jc[0].n} old calib_still job(s) (releases their keys)`);
  console.log(`    4. queue ${totalCells} cells = ${totalFrames} frames`);
  console.log(`\n  Supplier cost : ~$${(totalFrames * 3.5 / 100).toFixed(2)} (recorded, charged to nobody)`);
  console.log(`  Credits       : ${preview.credits >= 0 ? preview.credits : 0}`);

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --full --yes to do it.');
    console.log('  (API + inline worker must be running and fal reachable, or the frames queue and wait.)\n');
    await pool.end();
    return;
  }

  // Prime: deactivate, clear baselines, cancel old jobs — one transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE avatar_loras SET active = FALSE WHERE id = $1', [lora.id]);
    await client.query('DELETE FROM expression_baselines WHERE lora_id = $1', [lora.id]);
    await client.query(
      `UPDATE render_jobs SET status = 'cancelled', updated_at = NOW()
        WHERE stage = 'calib_still' AND payload->>'lora_id' = $1 AND status <> 'cancelled'`,
      [String(lora.id)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    die(`Prime failed, rolled back (nothing changed): ${e.message}`);
  } finally {
    client.release();
  }
  console.log('\n  Primed: deactivated, baselines cleared, old jobs cancelled.');

  // Queue every cell fresh. allowActive is moot now (she is inactive) but honest.
  let result;
  try {
    result = await CalibrationRun.submit(avatar.tenant_id, lora.id, {
      framings, samples: SAMPLES, allowActive: true, userId: null, ip: null,
    });
  } catch (e) {
    if (e.code === 'NOT_ENOUGH_CREDITS') {
      die(`${e.message}\n    She is already deactivated + cleared. Top up then re-queue:\n`
        + `      node studio/grant-credits.js\n`
        + `      node studio/recalibrate-aanya.js --full --yes   # baselines already gone, so this just re-queues`);
    }
    die(`Submit failed (she is deactivated + cleared; fix the cause and re-run --full --yes): ${e.message}`);
  }

  console.log(`  Queued ${result.queued} frames across ${result.cells.length} cells (run ${result.run}).`);
  console.log('\n  The chain records each baseline as its cell finishes. When every preset is measured:');
  console.log('    node studio/calibration-report.js        # confirm no cell is on the crutch');
  console.log('    node studio/recalibrate-aanya.js --activate --yes   # bring her back\n');
  await pool.end();
}

// ── Additive (keep her live; add only the missing framings) ───────────────────
async function additive() {
  const { avatar, lora } = await findLora();
  const { rows: base } = await pool.query(
    'SELECT DISTINCT framing FROM expression_baselines WHERE avatar_id = $1 AND lora_id = $2',
    [avatar.id, lora.id]);
  const have = new Set(base.map((r) => r.framing));
  const missing = Calibration.FRAMINGS.filter((f) => !have.has(f));
  let framings = chosen ? chosen.split(',').map((s) => s.trim()).filter(Boolean) : missing;
  framings = framings.filter((f) => Calibration.FRAMINGS.includes(f) && !have.has(f));
  if (!framings.length) {
    die(`Nothing additive to do (measured: ${[...have].join(', ') || 'none'}). `
      + `For a full rebuild use --full.`);
  }
  console.log(`\n  ${avatar.name} (#${avatar.id}) — LoRA v${lora.version} (additive, keeping her live)`);
  console.log(`  Adding framings: ${framings.join(', ')}   samples/cell: ${SAMPLES}`);
  const preview = await CalibrationRun.preview(avatar.tenant_id, lora.id, { framings, samples: SAMPLES });
  console.log(`  Cells: ${preview.cells.length}  Frames: ${preview.total_frames}  Credits: ${preview.credits}  ~$${(preview.estimated_cost_cents / 100).toFixed(2)}`);
  if (!APPLY) { console.log('\n  Dry run. Re-run with --yes to queue it.\n'); await pool.end(); return; }
  let result;
  try {
    result = await CalibrationRun.submit(avatar.tenant_id, lora.id, {
      framings, samples: SAMPLES, allowActive: true, userId: null, ip: null,
    });
  } catch (e) {
    if (e.code === 'NOT_ENOUGH_CREDITS') die(`${e.message}\n    Top up:  node studio/grant-credits.js`);
    die(`Submit failed: ${e.message}`);
  }
  console.log(`\n  Queued ${result.queued} frames across ${result.cells.length} cells (run ${result.run}).`);
  console.log('  Watch it:  node studio/calibration-report.js\n');
  await pool.end();
}

(async () => {
  if (ACTIVATE) return reactivate();
  if (FULL) return fullRecal();
  return additive();
})().catch((e) => die(e.message));
