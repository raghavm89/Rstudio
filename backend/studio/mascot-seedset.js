#!/usr/bin/env node
'use strict';

/**
 * Build a CONSISTENT seed set for a ZoQ mascot LoRA, from one chosen "hero"
 * squirrel still.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * flux/dev gives a DIFFERENT squirrel every render, and the repo's identity-
 * preserving endpoint (fal-ai/flux-pulid, the `_runAnchored` path) is a HUMAN
 * FACE model — it can't lock a non-human character. So a mascot LoRA is seeded
 * the image-conditioned way: pick one hero squirrel, img2img many varied poses
 * from it (keeping the violet-hoodie identity in every prompt), then CULL hard to
 * the frames that clearly read as the same squirrel. The cull is what enforces
 * consistency — accept drift in generation, reject the off-model frames — exactly
 * as Aanya's set was culled (209 → 16 keepers). Runs in YOUR Terminal (fal is
 * blocked from the Cowork sandboxes).
 *
 *     node studio/mascot-seedset.js --hero creator            # plan + price only
 *     node studio/mascot-seedset.js --hero creator --yes      # render + spend (~cents)
 *
 * Flags:
 *     --hero <key|path>   which mascot still to lock (creator|skating|eating|
 *                         fighting|flying|hero, default creator), or a file path
 *     --n <k>             pool frames to generate (default 30)
 *     --no-anchor         skip the clean prop-free anchor step, seed straight from hero
 *     --strengths a,b,c   img2img strengths to rotate (default 0.55,0.62,0.7)
 *     --yes               actually render + spend
 *
 * Output: frontend/public/hero/mascot/seedset/{anchor.jpg, cand-NN.jpg}.
 * Then cull by hand to ~16-20 on-model frames and run mascot-train.js.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));

const API = 'https://queue.fal.run';
const I2I_MODEL = process.env.FAL_I2I_MODEL || 'fal-ai/flux/dev/image-to-image';
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const CENTS_PER_MP = Number(process.env.FAL_PRICE_STILL_CENTS ?? 3.5);
const MASCOT_DIR = path.join(ROOT, '..', 'frontend', 'public', 'hero', 'mascot');
const OUT_DIR = path.join(MASCOT_DIR, 'seedset');

const args = process.argv.slice(2);
const flag = (n, fb = null) => { const i = args.indexOf(`--${n}`); if (i === -1) return fb; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const CONFIRMED = args.includes('--yes');
const NO_ANCHOR = args.includes('--no-anchor');
const HERO = String(flag('hero', 'creator'));
const N = Math.max(6, Number(flag('n', 30)));
const STRENGTHS = String(flag('strengths', '0.55,0.62,0.7')).split(',').map(Number).filter((x) => x > 0 && x < 1);

// The constant character — restated in EVERY prompt so img2img holds identity.
const IDENTITY = 'a cute chubby 3D cartoon squirrel mascot, warm reddish-brown fluffy fur, '
  + 'big expressive dark round eyes, small rounded ears, a big bushy curled tail, '
  + 'wearing a small violet purple hoodie, Pixar DreamWorks 3D animation style';
const STUDIO = 'plain light-grey studio background, soft even studio lighting, full body, centered';

// Vary POSE / ANGLE / EXPRESSION so the LoRA learns the character, not one pose.
const POSES = [
  'standing front view, arms relaxed', 'three-quarter view from the left',
  'three-quarter view from the right', 'side profile view', 'sitting down',
  'waving one paw, cheerful', 'arms crossed, confident', 'looking up, curious',
  'mid-jump, energetic', 'running pose', 'back view showing the bushy tail',
  'close-up of the face, smiling', 'crouching, playful', 'hands on hips, proud',
  'surprised, wide eyes', 'laughing happily', 'winking, one eye closed',
  'leaning to one side, relaxed', 'looking over the shoulder', 'giving a thumbs up',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });

async function run(input, label) {
  process.stdout.write(`  ${label}… `);
  const s = await fetch(`${API}/${I2I_MODEL}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const q = await s.json().catch(() => ({}));
  if (!s.ok) throw new Error(`HTTP ${s.status} ${JSON.stringify(q).slice(0, 200)}`);
  if (!q.status_url) throw new Error(`no status_url: ${JSON.stringify(q).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await (await fetch(q.status_url, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st.error || st).slice(0, 200)}`);
    if (Date.now() - t0 > 4 * 60 * 1000) throw new Error('timed out');
  }
  const out = await (await fetch(q.response_url, { headers: headers() })).json();
  if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts.some(Boolean)) throw new Error('content-filtered');
  const im = (out.images || [])[0];
  if (!im || !im.url) throw new Error(`no image: ${JSON.stringify(out).slice(0, 160)}`);
  console.log('ok');
  return im.url;
}

async function download(url, dest) {
  const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (backend .env).'); process.exit(1); }
  const heroPath = fs.existsSync(HERO) ? HERO : path.join(MASCOT_DIR, `${HERO}.jpg`);
  if (!fs.existsSync(heroPath)) { console.error(`Hero not found: ${heroPath}\nRun generate-mascot.js first, or pass --hero <path>.`); process.exit(1); }

  const total = N + (NO_ANCHOR ? 0 : 1);
  const mp = 0.8; // ~768x1024
  console.log(`\nModel: ${I2I_MODEL}   hero: ${path.basename(heroPath)}   frames: ${N}${NO_ANCHOR ? '' : ' (+1 anchor)'}   strengths: ${STRENGTHS.join(', ')}`);
  console.log(`Est. spend: ~${(total * mp * CENTS_PER_MP / 100).toFixed(2)} USD\n`);
  if (!CONFIRMED) { console.log('Dry run — add --yes to render and spend. Then CULL to ~16-20 on-model frames before training.'); return; }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const provider = new FalProvider({ apiKey: KEY });

  // upload hero -> fal CDN (img2img fetches the URL)
  process.stdout.write('  uploading hero… ');
  let anchorUrl = await provider.uploadToFalStorage(fs.readFileSync(heroPath), { filename: 'hero.jpg', contentType: 'image/jpeg' });
  console.log('ok');

  // Stage 0 — a clean, prop-free anchor so props (phone/acorn/cape) don't bake into the LoRA.
  if (!NO_ANCHOR) {
    try {
      const url = await run({
        image_url: anchorUrl,
        prompt: `${IDENTITY}, standing front view, arms relaxed, no props, empty paws, neutral friendly expression, ${STUDIO}`,
        strength: 0.5, num_inference_steps: 34, guidance_scale: 3.5, num_images: 1, enable_safety_checker: true,
      }, 'clean anchor');
      const p = path.join(OUT_DIR, 'anchor.jpg');
      await download(url, p);
      anchorUrl = await provider.uploadToFalStorage(fs.readFileSync(p), { filename: 'anchor.jpg', contentType: 'image/jpeg' });
    } catch (e) { console.log(`  clean anchor SKIPPED (${e.message}) — seeding from the hero instead`); }
  }

  let made = 0;
  for (let i = 0; i < N; i++) {
    const pose = POSES[i % POSES.length];
    const strength = STRENGTHS[i % STRENGTHS.length];
    try {
      const url = await run({
        image_url: anchorUrl,
        prompt: `${IDENTITY}, ${pose}, no props, ${STUDIO}`,
        strength, num_inference_steps: 30, guidance_scale: 3.5, num_images: 1, enable_safety_checker: true,
      }, `frame ${String(i + 1).padStart(2, '0')} (${pose.slice(0, 22)}, s${strength})`);
      await download(url, path.join(OUT_DIR, `cand-${String(i + 1).padStart(2, '0')}.jpg`));
      made++;
    } catch (e) { console.log(`    frame ${i + 1} SKIPPED: ${e.message}`); }
  }
  console.log(`\nWrote ${made} candidate(s) to frontend/public/hero/mascot/seedset/`);
  console.log('NEXT: open that folder, DELETE every frame that is not clearly the same squirrel');
  console.log('(off fur colour, wrong hoodie, melted face, extra limbs), keep ~16-20, then:');
  console.log('  node studio/mascot-train.js --yes');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
