#!/usr/bin/env node
'use strict';

/**
 * Animate the ZoQ mascot stills into short looping clips (Seedance i2v).
 *
 * Turns each frontend/public/hero/mascot/<pose>.jpg into <pose>.mp4 so the hero
 * can show the mascot in MOTION per use-case. Runs in YOUR Terminal (fal is
 * blocked from the Cowork sandboxes); no ngrok needed — each still is pushed to
 * fal's own CDN first (uploadToFalStorage), exactly like hero-assets.js does.
 *
 *     node studio/generate-mascot-videos.js                 # plan + price, spends nothing
 *     node studio/generate-mascot-videos.js --yes           # actually renders (video = pricey)
 *     node studio/generate-mascot-videos.js --only creator,skating --yes
 *     node studio/generate-mascot-videos.js --resolution 720p --seconds 5 --yes
 *
 * Flags:
 *     --yes                 actually render + spend
 *     --only a,b            only these pose keys (filenames without .jpg/.mp4)
 *     --resolution 480p|720p   default 480p (mobile-friendly + cheaper)
 *     --seconds <n>         clip length, default 5
 *     --force               re-render even poses that already have an .mp4
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));

const API = 'https://queue.fal.run';
const MOTION_MODEL = process.env.FAL_MOTION_MODEL || 'fal-ai/bytedance/seedance/v1/pro/image-to-video';
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const DIR = path.join(ROOT, '..', 'frontend', 'public', 'hero', 'mascot');

const args = process.argv.slice(2);
const flag = (n, fb = null) => { const i = args.indexOf(`--${n}`); if (i === -1) return fb; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const CONFIRMED = args.includes('--yes');
const FORCE = args.includes('--force');
const ONLY = flag('only', null);
const ONLY_SET = ONLY ? String(ONLY).split(',').map((s) => s.trim()).filter(Boolean) : null;
const RES = String(flag('resolution', '480p'));
const SECONDS = Number(flag('seconds', 5));

// Gentle, loop-friendly motion per pose — keep the character, move the scene.
const MOTION = {
  flying:  'the squirrel glides smoothly through the air, fur and bushy tail fluttering in the wind, gentle floating motion',
  skating: 'the squirrel rolls forward on the skateboard, filming itself, slight bob and sway, tail balancing',
  eating:  'the squirrel happily nibbles the acorn, cheeks moving, ears twitch, tail sways softly',
  fighting:'the squirrel shifts in its fighting stance and throws a quick playful jab, tail flicks, alert',
  hero:    'the squirrel stands heroically, hoodie and tail fluttering, subtle confident breathing, tiny nod',
  creator: 'the squirrel grins and gives a thumbs up, phone in paw, slight excited bounce, tail sways',
};
const FALLBACK_MOTION = 'the character comes to life with subtle natural motion, fur and tail moving gently';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });

async function run(model, input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`HTTP ${submit.status} ${JSON.stringify(queued).slice(0, 200)}`);
  const { status_url, response_url } = queued;
  if (!status_url) throw new Error(`No status_url: ${JSON.stringify(queued).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(3000);
    const st = await (await fetch(status_url, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st.error || st).slice(0, 240)}`);
    if (Date.now() - t0 > 8 * 60 * 1000) throw new Error('timed out');
    process.stdout.write('.');
  }
  const out = await (await fetch(response_url, { headers: headers() })).json();
  console.log(`done (${Math.round((Date.now() - t0) / 1000)}s)`);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (read from backend .env).'); process.exit(1); }
  if (!fs.existsSync(DIR)) { console.error(`No mascot folder: ${DIR}\nRun generate-mascot.js --yes first.`); process.exit(1); }

  let poses = fs.readdirSync(DIR).filter((f) => f.endsWith('.jpg')).map((f) => f.replace(/\.jpg$/, ''));
  if (ONLY_SET) poses = poses.filter((p) => ONLY_SET.includes(p));
  if (!FORCE) poses = poses.filter((p) => !fs.existsSync(path.join(DIR, `${p}.mp4`)));
  if (!poses.length) { console.log('Nothing to render (all clips exist? use --force, or check --only).'); return; }

  const provider = new FalProvider({ apiKey: KEY });
  const rate = provider.pricing.motionPerSecondCentsByResolution[RES]
    ?? Math.max(...Object.values(provider.pricing.motionPerSecondCentsByResolution));
  const estCents = poses.length * SECONDS * rate;
  console.log(`\nMotion model: ${MOTION_MODEL}   resolution: ${RES}   ${SECONDS}s/clip`);
  console.log(`Poses: ${poses.join(', ')}`);
  console.log(`Est. spend: ~${(estCents / 100).toFixed(2)} USD  (${poses.length} clips × ${SECONDS}s × ${rate}¢/s)\n`);
  if (!CONFIRMED) { console.log('Dry run — add --yes to render and spend. Video is far pricier than stills.'); return; }

  const made = [];
  for (const p of poses) {
    try {
      const bytes = fs.readFileSync(path.join(DIR, `${p}.jpg`));
      process.stdout.write(`  ${p}: upload… `);
      const imageUrl = await provider.uploadToFalStorage(bytes, { filename: `${p}.jpg`, contentType: 'image/jpeg' });
      console.log('ok');
      const out = await run(MOTION_MODEL, {
        image_url: imageUrl,
        prompt: MOTION[p] || FALLBACK_MOTION,
        resolution: RES,
        duration: String(SECONDS),
        camera_fixed: true,
      }, `  ${p}: motion`);
      const videoUrl = out.video?.url || out.url;
      if (!videoUrl) throw new Error(`no video: ${JSON.stringify(out).slice(0, 200)}`);
      const dest = path.join(DIR, `${p}.mp4`);
      const mb = (await download(videoUrl, dest)) / 1024 / 1024;
      console.log(`    ${p}.mp4  ${mb.toFixed(1)} MB`);
      made.push(path.relative(path.join(ROOT, '..'), dest));
    } catch (e) {
      console.log(`    ${p} … SKIPPED: ${e.message}`);
    }
  }
  console.log(`\nWrote ${made.length} clip(s) to frontend/public/hero/mascot/:`);
  made.forEach((p) => console.log('  ' + p));
  console.log('\nTell Claude when done — I can pull them in and wire the videos into the hero.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
