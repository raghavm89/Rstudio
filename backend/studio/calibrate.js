#!/usr/bin/env node
'use strict';

/**
 * Read the calibration plan for a trained LoRA — the price, before you spend it.
 *
 * The runbook said `GET /api/studio/loras/:id/calibration`, which is an HTTP
 * endpoint rather than a command, needs a bearer token, and tells you nothing
 * about where to type it. This is that endpoint, run locally against the same
 * service the API calls.
 *
 *     node studio/calibrate.js --lora 3
 *     node studio/calibrate.js --lora 3 --framings medium --samples 6
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It still only reads. It prints the plan and the readiness; it does not
 * generate the frames and it does not record the scores.
 *
 * That used to be a gap — "the generating half needs a shoot to run through
 * the queue, which is the orchestrator's job rather than a script's" — and it
 * is not one any more. `calibrationRun.js` queues the frames as `calib_still`
 * jobs naming the inactive model, and `POST /api/studio/loras/:id/calibration/run`
 * is the button. A script is the wrong place for it: it spends money, and the
 * person spending it should be looking at the price in the product rather than
 * at a terminal they do not have.
 *
 * So this stays a read, which is what a script is good for.
 *
 * ── Why the framings flag matters more than it looks ────────────────────────
 * All three framings across every preset is roughly two hundred frames. Medium
 * alone is a third of that, and the QC fallback chain degrades sensibly — exact
 * cell, then the same expression at any framing, then a permissive floor — so an
 * uncalibrated framing is not a rejected one. Start at medium; add close and
 * wide once she is earning.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const pool = require(path.join(ROOT, 'src/config/db'));
const Calibration = require(path.join(ROOT, 'src/services/studio/calibration'));

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const LORA_ID = Number(flag('lora', 0));
const SAMPLES = Math.min(Math.max(Number(flag('samples', 6)), 5), 12);
const FRAMINGS = flag('framings', null);

const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

async function main() {
  if (!LORA_ID) {
    // Be useful rather than just refusing — the id is the one thing you cannot
    // guess, and it is one query away.
    const { rows } = await pool.query(
      `SELECT l.id, l.version, l.active, a.name, a.id AS avatar_id
         FROM avatar_loras l JOIN avatars a ON a.id = l.avatar_id
        ORDER BY l.id DESC LIMIT 10`
    );
    if (!rows.length) die('No trained LoRAs yet. Run  node studio/train.js --avatar 2 --yes  first.');
    console.log('\n  Which LoRA?\n');
    for (const r of rows) {
      console.log(`    --lora ${String(r.id).padEnd(4)} ${r.name} v${r.version}${r.active ? '  (active)' : ''}`);
    }
    console.log('');
    return;
  }

  const framings = FRAMINGS && FRAMINGS !== true
    ? String(FRAMINGS).split(',').map((f) => f.trim()).filter(Boolean)
    : undefined;

  const unknown = (framings || []).filter((f) => !Calibration.FRAMINGS.includes(f));
  if (unknown.length) die(`Unknown framing(s): ${unknown.join(', ')}. Known: ${Calibration.FRAMINGS.join(', ')}`);

  const { rows } = await pool.query(
    `SELECT l.id, l.version, l.active, a.tenant_id, a.name
       FROM avatar_loras l JOIN avatars a ON a.id = l.avatar_id WHERE l.id = $1`,
    [LORA_ID]
  );
  const lora = rows[0];
  if (!lora) die(`No LoRA #${LORA_ID}.`);

  let plan;
  try {
    plan = await Calibration.plan(lora.tenant_id, LORA_ID, {
      samples: SAMPLES,
      ...(framings ? { framings } : {}),
    });
  } catch (err) {
    die(`${err.message}${err.code ? `  [${err.code}]` : ''}`);
  }

  console.log(`\nCalibration plan — ${lora.name}, LoRA #${lora.id} v${lora.version}\n`);
  console.log(`  Cells      ${plan.cells?.length ?? '?'}  (expression × framing)`);
  console.log(`  Samples    ${SAMPLES} per cell`);
  console.log(`  Frames     ${plan.total_frames ?? plan.frames ?? '?'}`);
  if (plan.estimated_cost_usd != null) console.log(`  Cost       ~$${Number(plan.estimated_cost_usd).toFixed(2)}`);
  else if (plan.estimated_cost_cents != null) console.log(`  Cost       ~$${(Number(plan.estimated_cost_cents) / 100).toFixed(2)}`);
  console.log(`  Framings   ${(framings || Calibration.FRAMINGS).join(', ')}`);

  let ready;
  try {
    ready = await Calibration.readiness(lora.tenant_id, LORA_ID);
  } catch (err) {
    ready = { error: err.message };
  }

  console.log('\n  Readiness');
  if (ready.error) {
    console.log(`    ${ready.error}`);
  } else {
    console.log(`    ready: ${ready.ready}`);
    if (ready.missing?.length) {
      console.log(`    still to measure: ${ready.missing.slice(0, 8).join(', ')}${ready.missing.length > 8 ? ` … +${ready.missing.length - 8}` : ''}`);
    }
    // It refuses to call a model ready on neutral alone, on purpose: a model
    // calibrated only on neutral passes a naive check and then silently rejects
    // every laughing frame it ever makes.
    if (!ready.ready) console.log('    (neutral alone is never enough — the gate would reject every emotional frame)');
  }

  console.log('\n  The recording half is not scripted yet: generating the frames needs a');
  console.log('  shoot through the queue rather than a loop here. Until it is,');
  console.log('  activation is deliberate rather than automatic — the LoRA stays');
  console.log('  inactive and the QC gate falls back to its permissive floor.\n');
}

main()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
