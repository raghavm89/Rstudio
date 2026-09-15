#!/usr/bin/env node
'use strict';

/**
 * Generate the LOCKED ZoQ mascot — one consistent squirrel — from the trained
 * LoRA. This is the payoff: the same character across every context, so it can
 * replace the six one-off flux/dev squirrels on /mascot. Runs in YOUR Terminal.
 *
 *     node studio/mascot-generate.js --lora <url|path>            # plan + price
 *     node studio/mascot-generate.js --lora <url|path> --yes      # render + spend
 *
 * Flags:
 *     --lora <url|path>   the .safetensors (a fal URL from mascot-train.js, or a
 *                         local backend/studio/loras/*.safetensors — uploaded for you)
 *     --trigger <word>    must match training (default zoqmascot)
 *     --only a,b          only these context keys
 *     --scale <n>         LoRA scale (default 0.95)  · --size WxH (default 768x1024)
 *
 * Writes frontend/public/hero/mascot/locked/<key>.jpg. Then re-animate with
 * generate-mascot-videos.js pointed at that folder, or copy the winners over the
 * old /mascot stills.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));
const API = 'https://queue.fal.run';
const LORA_MODEL = process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora';
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const CENTS_PER_MP = Number(process.env.FAL_PRICE_STILL_CENTS ?? 3.5);
const OUT_DIR = path.join(ROOT, '..', 'frontend', 'public', 'hero', 'mascot', 'locked');

const args = process.argv.slice(2);
const flag = (n, fb = null) => { const i = args.indexOf(`--${n}`); if (i === -1) return fb; const v = args[i + 1]; return v && !v.startsWith('--') ? v : fb; };
const CONFIRMED = args.includes('--yes');
const LORA = flag('lora', null);
const TRIGGER = String(flag('trigger', 'zoqmascot'));
const SCALE = Number(flag('scale', 0.95));
const ONLY = flag('only', null);
const ONLY_SET = ONLY ? String(ONLY).split(',').map((s) => s.trim()) : null;
const SIZE = String(flag('size', '768x1024')).split('x').map(Number);
const [W, H] = [SIZE[0] || 768, SIZE[1] || 1024];

const STYLE = 'cute chubby 3D cartoon squirrel mascot, warm reddish-brown fur, big expressive eyes, '
  + 'big bushy tail, small violet purple hoodie, Pixar DreamWorks 3D render, cinematic studio lighting, '
  + 'soft violet rim light, dark charcoal background, centered, portrait';
const CONTEXTS = {
  creator:  'grinning and giving a thumbs up while holding a smartphone showing a play button',
  skating:  'riding a skateboard mid trick, filming itself with a phone, backwards cap, energetic',
  eating:   'sitting and happily nibbling a big acorn held in both paws, cheeks full',
  fighting: 'dynamic kung-fu action pose mid strike, wearing a violet headband',
  flying:   'gliding through the air, arms spread like a flying squirrel, tiny aviator goggles',
  hero:     'confident superhero landing pose, hoodie flaring like a cape, heroic',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });

async function run(input, label) {
  process.stdout.write(`  ${label}… `);
  const s = await fetch(`${API}/${LORA_MODEL}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
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
  const im = (out.images || [])[0];
  if (!im || !im.url) throw new Error(`no image: ${JSON.stringify(out).slice(0, 160)}`);
  console.log('ok'); return im.url;
}
async function download(url, dest) { const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status}`); fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer())); }

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set.'); process.exit(1); }
  if (!LORA) { console.error('--lora <url|path> is required (from mascot-train.js).'); process.exit(1); }
  const keys = Object.keys(CONTEXTS).filter((k) => !ONLY_SET || ONLY_SET.includes(k));
  const mp = (W * H) / 1e6;
  console.log(`\nModel: ${LORA_MODEL}   trigger: ${TRIGGER}   scale: ${SCALE}   size: ${W}x${H}`);
  console.log(`Contexts: ${keys.join(', ')}`);
  console.log(`Est. spend: ~${(keys.length * mp * CENTS_PER_MP / 100).toFixed(2)} USD\n`);
  if (!CONFIRMED) { console.log('Dry run — add --yes to render and spend.'); return; }

  // Resolve the LoRA to a URL fal can fetch.
  let loraUrl = LORA;
  if (!/^https?:\/\//i.test(LORA)) {
    const p = path.isAbsolute(LORA) ? LORA : path.join(__dirname, 'loras', LORA);
    if (!fs.existsSync(p)) { console.error(`LoRA file not found: ${p}`); process.exit(1); }
    process.stdout.write('  uploading LoRA to fal CDN… ');
    loraUrl = await new FalProvider({ apiKey: KEY }).uploadToFalStorage(fs.readFileSync(p), { filename: 'lora.safetensors', contentType: 'application/octet-stream' });
    console.log('ok');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const made = [];
  for (const k of keys) {
    try {
      const url = await run({
        prompt: `${TRIGGER}, ${CONTEXTS[k]}. ${STYLE}`,
        image_size: { width: W, height: H },
        num_images: 1, num_inference_steps: 32, guidance_scale: 3.5,
        loras: [{ path: loraUrl, scale: SCALE }],
        enable_safety_checker: true, output_format: 'jpeg',
      }, k);
      const dest = path.join(OUT_DIR, `${k}.jpg`);
      await download(url, dest);
      made.push(path.relative(path.join(ROOT, '..'), dest));
    } catch (e) { console.log(`    ${k} SKIPPED: ${e.message}`); }
  }
  console.log(`\nWrote ${made.length} locked mascot image(s) to frontend/public/hero/mascot/locked/:`);
  made.forEach((p) => console.log('  ' + p));
  console.log('\nSame squirrel every time now. Tell Claude when done — I can swap them onto /mascot and re-animate.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
