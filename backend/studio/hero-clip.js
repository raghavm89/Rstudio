#!/usr/bin/env node
'use strict';

/**
 * Render a hero CLIP for any avatar: a still, then image-to-video from it, then
 * wire it into the avatar's Plate manifest (frontend/public/hero/<slug>/).
 *
 * Unlike hero-assets (Aanya-hardcoded), this reads the avatar's identity block +
 * trigger from the DB and uses fal's hosted LoRA copy from the training job — no
 * tunnel. The scene + motion are flags, so any avatar can get a moving hero.
 *
 *   node studio/hero-clip.js --avatar 6 --lora-job 938 \
 *     --scene "standing behind his cafe counter, brewing a pour-over coffee, steam rising" \
 *     --motion "he brews the coffee, steam rising and drifting, his hands move slowly, a calm natural motion, he glances up at camera"
 *
 * Defaults are Rohan-at-his-cafe. ~$0.31 (still $0.04 + 5s 720p motion ~$0.27).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));

const API = 'https://queue.fal.run';
const STILL_MODEL = process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora';
const MOTION_MODEL = process.env.FAL_MOTION_MODEL || 'fal-ai/bytedance/seedance/v1/pro/image-to-video';
const LORA_TRAINER = process.env.FAL_LORA_TRAINER || 'fal-ai/flux-lora-fast-training';
const KEY = process.env.FAL_KEY;
const W = 880, H = 1104;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });
const flag = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

async function loraUrlFromJob(jobId) {
  const { rows } = await pool.query('SELECT stage, result FROM render_jobs WHERE id = $1', [Number(jobId)]);
  const job = rows[0];
  if (!job) throw new Error(`No job #${jobId}.`);
  if (job.stage !== 'lora_train') throw new Error(`Job #${jobId} is stage '${job.stage}', not lora_train.`);
  const requestId = job.result && job.result.request_id;
  const model = (job.result && job.result.model) || LORA_TRAINER;
  if (!requestId) throw new Error(`Job #${jobId} recorded no fal request_id.`);
  const res = await fetch(`${API}/${model}/requests/${requestId}`, { headers: headers() });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`fal HTTP ${res.status} re-reading job #${jobId}.`);
  const url = out.diffusers_lora_file && out.diffusers_lora_file.url;
  if (!url) throw new Error('That training result has no diffusers_lora_file url.');
  return url;
}

async function run(model, input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`HTTP ${submit.status}: ${JSON.stringify(queued).slice(0, 200)}`);
  const statusUrl = queued.status_url, responseUrl = queued.response_url;
  if (!statusUrl) throw new Error(`No status_url: ${JSON.stringify(queued).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await (await fetch(statusUrl, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st.error || st).slice(0, 200)}`);
    if (Date.now() - t0 > 10 * 60 * 1000) throw new Error('timed out');
    process.stdout.write('.');
  }
  const out = await (await fetch(responseUrl, { headers: headers() })).json();
  if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts.some(Boolean)) throw new Error('refused on content policy (still billed)');
  console.log(` done (${Math.round((Date.now() - t0) / 1000)}s)`);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set.'); process.exit(1); }
  const who = flag('avatar');
  if (!who) { console.error('Usage: node studio/hero-clip.js --avatar <id|slug> --lora-job <trainJobId> [--scene "..."] [--motion "..."] [--seconds 5] [--resolution 720p]'); process.exit(1); }
  const scale = Number(flag('scale', 1.0));
  const seconds = Number(flag('seconds', 5));
  const resolution = String(flag('resolution', '720p'));
  const byId = /^\d+$/.test(String(who));
  const { rows } = await pool.query(
    `SELECT id, slug, name, identity_block, lora_trigger FROM avatars WHERE ${byId ? 'id = $1' : 'slug = $1'} LIMIT 1`,
    [byId ? Number(who) : who]
  );
  const av = rows[0];
  if (!av) { console.error(`No avatar "${who}".`); process.exit(1); }

  const jobId = flag('lora-job');
  const loraUrl = flag('lora-url') || (jobId ? await loraUrlFromJob(jobId) : null);
  if (!loraUrl) { console.error('No LoRA URL — pass --lora-job <trainJobId>.'); process.exit(1); }

  const scene = flag('scene', 'standing behind his cafe counter, brewing a pour-over filter coffee, steam rising from the cup, one hand on the kettle, a plain crew-neck tee, warm pendant light, exposed brick and shelves of jars behind');
  const motion = flag('motion', 'he is brewing the coffee, steam rises and drifts from the cup, his hands move slowly and steadily as he pours, a calm natural motion, he glances up toward the camera with a small smile; the cafe stays still around him');

  const outDir = path.join(__dirname, '..', '..', 'frontend', 'public', 'hero', av.slug);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  Hero clip for ${av.name} (#${av.id}) — trigger ${av.lora_trigger}`);
  console.log(`  scene:  ${scene.slice(0, 80)}…`);
  console.log(`  motion: ${motion.slice(0, 80)}…\n`);

  // 1) the still the clip is generated from
  const stillPrompt = `${av.lora_trigger}, ${av.identity_block}, ${scene}, natural relaxed expression, `
    + 'candid photograph, soft warm light, sharp focus, realistic skin texture';
  const stillOut = await run(STILL_MODEL, {
    prompt: stillPrompt, image_size: { width: W, height: H }, num_images: 1,
    guidance_scale: 3.5, loras: [{ path: loraUrl, scale }],
  }, 'Still');
  const stillUrl = stillOut.images && stillOut.images[0] && stillOut.images[0].url;
  if (!stillUrl) throw new Error('No still image returned.');
  await download(stillUrl, path.join(outDir, 'hero-still.jpg'));

  // 2) image-to-video from that still
  const motionOut = await run(MOTION_MODEL, {
    image_url: stillUrl, prompt: motion, resolution, duration: String(seconds), camera_fixed: true,
  }, 'Motion');
  const videoUrl = motionOut.video && motionOut.video.url || motionOut.url;
  if (!videoUrl) throw new Error(`No video in reply: ${JSON.stringify(motionOut).slice(0, 200)}`);
  await download(videoUrl, path.join(outDir, 'hero.mp4'));

  // 3) wire it into the Plate manifest (poster = the clip's first frame)
  const manifestPath = path.join(outDir, 'hero-manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  manifest = {
    ...manifest, avatar: av.slug, name: av.name,
    poster: `/hero/${av.slug}/hero-still.jpg`,
    video: `/hero/${av.slug}/hero.mp4`,
    width: W, height: H, seconds, resolution,
    setups: manifest.setups || [],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n  Done. hero.mp4 + hero-still.jpg + manifest in frontend/public/hero/${av.slug}/`);
  console.log('  Reload /persona — the hero now plays the clip.\n');
  await pool.end();
})().catch((e) => { console.error('\n  x', e.message, '\n'); process.exit(1); });
