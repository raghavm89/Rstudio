#!/usr/bin/env node
'use strict';

/**
 * Train the ZoQ mascot LoRA from a CULLED seed set, on fal
 * (fal-ai/flux-lora-fast-training) — the same trainer + owned .safetensors as
 * Aanya (~$2). Runs in YOUR Terminal (fal is blocked from the Cowork sandboxes).
 *
 *     node studio/mascot-train.js              # plan + price only
 *     node studio/mascot-train.js --yes        # zip + train + download (~$2, minutes)
 *
 * Reads every .jpg/.png in frontend/public/hero/mascot/seedset/ (so CULL first —
 * delete the off-model frames), zips them, and trains. Writes the LoRA to
 * backend/studio/loras/<trigger>.safetensors and prints the fal URL to reuse.
 *
 * Flags: --trigger <word> (default zoqmascot) · --steps <n> (default 1000)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const SEED_DIR = path.join(ROOT, '..', 'frontend', 'public', 'hero', 'mascot', 'seedset');
const LORA_DIR = path.join(__dirname, 'loras');

const args = process.argv.slice(2);
const flag = (n, fb = null) => { const i = args.indexOf(`--${n}`); if (i === -1) return fb; const v = args[i + 1]; return v && !v.startsWith('--') ? v : fb; };
const CONFIRMED = args.includes('--yes');
const TRIGGER = String(flag('trigger', 'zoqmascot')).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'zoqmascot';
const STEPS = Number(flag('steps', 1000));

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (backend .env).'); process.exit(1); }
  if (!fs.existsSync(SEED_DIR)) { console.error(`No seed set at ${SEED_DIR}\nRun mascot-seedset.js --yes first.`); process.exit(1); }
  const imgs = fs.readdirSync(SEED_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f));
  if (imgs.length < 8) { console.error(`Only ${imgs.length} images in the seed set — cull to ~16-20 good frames but keep at least ~10.`); process.exit(1); }

  console.log(`\nTrainer: fal-ai/flux-lora-fast-training   trigger: ${TRIGGER}   steps: ${STEPS}`);
  console.log(`Seed set: ${imgs.length} images from frontend/public/hero/mascot/seedset/`);
  console.log(`Est. spend: ~$2 (flat LoRA training)\n`);
  if (imgs.length > 26) console.log(`NB: ${imgs.length} images is a lot — 16-20 tightly-consistent frames train a cleaner character than many loose ones.`);
  if (!CONFIRMED) { console.log('Dry run — add --yes to zip, upload, train and download.'); return; }

  // zip the seed set (system zip; -j = flat, no dir entries)
  const zipPath = path.join(require('os').tmpdir(), `zoq-mascot-seedset-${Date.now()}.zip`);
  process.stdout.write('  zipping seed set… ');
  execFileSync('zip', ['-j', '-q', zipPath, ...imgs.map((f) => path.join(SEED_DIR, f))]);
  console.log(`${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);

  const provider = new FalProvider({ apiKey: KEY });
  process.stdout.write('  uploading to fal CDN… ');
  const zipUrl = await provider.uploadToFalStorage(fs.readFileSync(zipPath), { filename: 'seed-set.zip', contentType: 'application/zip' });
  console.log('ok');

  console.log('  training (minutes)… ');
  const res = await provider.runLoraTraining(
    { payload: { generation: { images_data_url: zipUrl, trigger_word: TRIGGER, steps: STEPS } } },
    { onProgress: (p) => p && p.status && process.stdout.write(`    ${p.status}\r`) },
  );
  const art = res.artifacts[0];
  fs.mkdirSync(LORA_DIR, { recursive: true });
  const dest = path.join(LORA_DIR, `${TRIGGER}.safetensors`);
  fs.writeFileSync(dest, await art.fetch());
  try { fs.unlinkSync(zipPath); } catch {}

  console.log(`\n✓ LoRA trained.`);
  console.log(`  file:  backend/studio/loras/${TRIGGER}.safetensors  (${(fs.statSync(dest).size / 1024 / 1024).toFixed(0)} MB)`);
  console.log(`  fal:   ${art.url}`);
  console.log(`  trigger word: "${TRIGGER}"`);
  console.log(`\nNEXT — generate the locked, consistent mascot:`);
  console.log(`  node studio/mascot-generate.js --lora "${art.url}" --yes`);
})().catch((e) => { console.error('\n' + (e.message || e)); process.exit(1); });
