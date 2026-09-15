#!/usr/bin/env node
'use strict';

/**
 * Generate AI squirrel-mascot options for ZoQ (Lane 02 hero plate).
 *
 * ── Why a script you run yourself ────────────────────────────────────────────
 * Same reason as generate-template-covers.js / hero-assets.js: neither Cowork
 * sandbox can reach fal.ai (DNS/egress blocked there). fal works fine from this
 * Mac, so this runs in YOUR Terminal:
 *
 *     node studio/generate-mascot.js            # plan + price only, spends nothing
 *     node studio/generate-mascot.js --yes      # actually renders + spends (~cents)
 *
 * It calls fal `flux/dev` (plain text-to-image, NO LoRA — the mascot is a brand
 * character, not Aanya) once per pose and writes each to
 * frontend/public/hero/mascot/<pose>.jpg. Pick the best; Claude embeds it on the
 * Lane 02 plate. (Note: flux/dev gives a DIFFERENT squirrel each run — this is
 * for choosing ONE hero image. Consistent multi-post mascots would need a small
 * mascot LoRA later, same as Aanya.)
 *
 * Flags:
 *     --yes            actually render + spend (otherwise dry-run: plan + price)
 *     --only a,b       only these pose keys (flying,skating,eating,fighting,hero,creator)
 *     --n <k>          images per pose (default 1)
 *     --steps <n>      inference steps (default 30)
 *     --size WxH       image size (default 768x1024, ~matches the 3:4 plate)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const API = 'https://queue.fal.run';
const MODEL = process.env.FAL_MASCOT_MODEL || 'fal-ai/flux/dev';
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const CENTS_PER_MP = Number(process.env.FAL_PRICE_STILL_CENTS ?? 3.5);

const OUT_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'hero', 'mascot');

const args = process.argv.slice(2);
const flag = (name, fb = null) => { const i = args.indexOf(`--${name}`); if (i === -1) return fb; const n = args[i + 1]; return n && !n.startsWith('--') ? n : true; };
const CONFIRMED = args.includes('--yes');
const ONLY = flag('only', null);
const ONLY_SET = ONLY ? String(ONLY).split(',').map((s) => s.trim()).filter(Boolean) : null;
const N = Math.max(1, Number(flag('n', 1)));
const STEPS = Number(flag('steps', 30));
const SIZE = String(flag('size', '768x1024')).split('x').map(Number);
const [W, H] = [SIZE[0] || 768, SIZE[1] || 1024];

// One brand style, shared by every pose, so all options read as the same product.
const STYLE = 'cute 3D rendered character squirrel mascot, Pixar DreamWorks animation style, '
  + 'big friendly expressive eyes, big fluffy tail, rounded appealing proportions, wearing a small violet hoodie, '
  + 'glossy polished studio render, soft cinematic key light with subtle violet rim light, '
  + 'dark charcoal seamless studio background, centered, full body, portrait composition, high detail';

const POSES = {
  flying:  'gliding through the air, arms and skin-flaps spread wide like a flying squirrel, wearing tiny aviator goggles, dynamic energetic mid-air pose, motion',
  skating: 'riding a skateboard mid kickflip, holding up a smartphone filming itself, backwards cap, energetic action, motion',
  eating:  'sitting up happily nibbling a big acorn held in both paws, cheeks full, cheerful',
  fighting:'dynamic kung-fu action pose mid strike, wearing a violet headband, determined, motion lines',
  hero:    'confident superhero landing pose, one fist to the ground, hoodie flaring like a cape, heroic low angle',
  creator: 'excited grin, holding up a smartphone showing a video play button, other paw giving a thumbs up',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });

async function run(input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${MODEL}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const hint = submit.status === 401 ? 'FAL_KEY invalid.' : submit.status === 403 ? 'Key rejected (zero credits or no access).' : '';
    throw new Error(`HTTP ${submit.status}. ${hint} ${JSON.stringify(queued).slice(0, 180)}`);
  }
  const { status_url, response_url } = queued;
  if (!status_url) throw new Error(`No status_url: ${JSON.stringify(queued).slice(0, 180)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await (await fetch(status_url, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st.error || st).slice(0, 200)}`);
    if (Date.now() - t0 > 5 * 60 * 1000) throw new Error('timed out');
    process.stdout.write('.');
  }
  const out = await (await fetch(response_url, { headers: headers() })).json();
  if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts.some(Boolean)) throw new Error('refused on content policy (still billed)');
  console.log(`done (${Math.round((Date.now() - t0) / 1000)}s)`);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (read from backend .env).'); process.exit(1); }
  const keys = Object.keys(POSES).filter((k) => !ONLY_SET || ONLY_SET.includes(k));
  if (!keys.length) { console.error('No matching poses. Options:', Object.keys(POSES).join(', ')); process.exit(1); }

  const mp = (W * H) / 1e6;
  const est = keys.length * N * mp * CENTS_PER_MP;
  console.log(`\nModel: ${MODEL}   size: ${W}x${H}   steps: ${STEPS}   images/pose: ${N}`);
  console.log(`Poses: ${keys.join(', ')}`);
  console.log(`Est. spend: ~${(est / 100).toFixed(2)} USD (${keys.length * N} images @ ~${(mp * CENTS_PER_MP).toFixed(1)}¢)\n`);
  if (!CONFIRMED) { console.log('Dry run — add --yes to render and spend.'); return; }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const made = [];
  for (const k of keys) {
    const input = {
      prompt: `${POSES[k]}. ${STYLE}`,
      image_size: { width: W, height: H },
      num_images: N,
      num_inference_steps: STEPS,
      guidance_scale: 3.5,
      enable_safety_checker: true,
    };
    try {
      const out = await run(input, k);
      let i = 0;
      for (const im of (out.images || [])) {
        const name = N > 1 ? `${k}-${++i}.jpg` : `${k}.jpg`;
        const dest = path.join(OUT_DIR, name);
        await download(im.url, dest);
        made.push(path.relative(path.join(__dirname, '..', '..'), dest));
      }
    } catch (e) {
      console.log(`  ${k} … SKIPPED: ${e.message}`);
    }
  }
  console.log(`\nWrote ${made.length} image(s) to frontend/public/hero/mascot/:`);
  made.forEach((p) => console.log('  ' + p));
  console.log('\nOpen that folder, pick your favourite, and tell Claude which one.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
