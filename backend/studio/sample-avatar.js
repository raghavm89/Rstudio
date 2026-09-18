#!/usr/bin/env node
'use strict';

/**
 * Render a few validation stills for ANY avatar from its OWN identity + LoRA.
 *
 * hero-assets.js is hardcoded to Aanya (her trigger, her woman-prompt), so it
 * cannot validate another avatar — point it at a male LoRA and you get Aanya's
 * wardrobe with a stranger's face. This reads the avatar's frozen identity block
 * and trigger from the DB and renders three framings from ITS LoRA, so a freshly
 * trained model can be eyeballed before spending credits on calibration.
 *
 * Uses fal's own hosted copy of the LoRA (recovered from the training job), so
 * no public storage tunnel is needed.
 *
 *   node studio/sample-avatar.js --avatar 6 --lora-job 938
 *   node studio/sample-avatar.js --avatar rohan-mehra --lora-job 938 --scale 0.9
 *
 * ~$0.12 for three stills. Runs on the Mac (DB + FAL_KEY).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));

const API = 'https://queue.fal.run';
const MODEL = process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora';
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
  if (!res.ok) throw new Error(`fal HTTP ${res.status} re-reading job #${jobId} (result may have expired — then use a storage tunnel).`);
  const url = out.diffusers_lora_file && out.diffusers_lora_file.url;
  if (!url) throw new Error('That training result has no diffusers_lora_file url.');
  return url;
}

async function run(input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${MODEL}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) throw new Error(`HTTP ${submit.status}: ${JSON.stringify(queued).slice(0, 200)}`);
  const statusUrl = queued.status_url;
  const responseUrl = queued.response_url;
  if (!statusUrl) throw new Error(`No status_url: ${JSON.stringify(queued).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await (await fetch(statusUrl, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st.error || st).slice(0, 200)}`);
    if (Date.now() - t0 > 8 * 60 * 1000) throw new Error('timed out');
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

const FRAMINGS = [
  ['close', 'tight close-up portrait, head and shoulders, face fills the frame'],
  ['medium', 'medium shot, head to mid-torso, three-quarter angle, looking just past the camera'],
  ['full', 'full-length shot, head to feet, standing, relaxed posture'],
];

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (backend .env).'); process.exit(1); }
  const who = flag('avatar');
  if (!who) { console.error('Usage: node studio/sample-avatar.js --avatar <id|slug> --lora-job <trainJobId> [--scale 1.0] [--out <dir>]'); process.exit(1); }
  const scale = Number(flag('scale', 1.0));
  const byId = /^\d+$/.test(String(who));
  const { rows } = await pool.query(
    `SELECT id, slug, name, identity_block, lora_trigger FROM avatars WHERE ${byId ? 'id = $1' : 'slug = $1'} LIMIT 1`,
    [byId ? Number(who) : who]
  );
  const av = rows[0];
  if (!av) { console.error(`No avatar "${who}".`); process.exit(1); }
  if (!av.lora_trigger || !av.identity_block) { console.error(`Avatar #${av.id} has no trigger/identity block.`); process.exit(1); }

  const jobId = flag('lora-job');
  const loraUrl = flag('lora-url') || (jobId ? await loraUrlFromJob(jobId) : null);
  if (!loraUrl) { console.error('No LoRA URL — pass --lora-job <trainJobId> (or --lora-url <https>).'); process.exit(1); }

  const outDir = flag('out', path.join(__dirname, 'personas', av.slug, 'samples'));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  Sampling ${av.name} (#${av.id}) — trigger ${av.lora_trigger}, scale ${scale}`);
  console.log(`  out ${outDir}\n`);

  for (const [key, framing] of FRAMINGS) {
    const prompt = `${av.lora_trigger}, ${av.identity_block}, ${framing}, natural relaxed expression, `
      + 'soft natural daylight, candid photograph, sharp focus, realistic skin texture with visible pores';
    const out = await run({
      prompt, image_size: { width: W, height: H }, num_images: 1,
      guidance_scale: 3.5, loras: [{ path: loraUrl, scale }],
    }, key);
    const url = out.images && out.images[0] && out.images[0].url;
    if (!url) { console.log('    (no image returned)'); continue; }
    const dest = path.join(outDir, `sample-${key}.jpg`);
    await download(url, dest);
    console.log(`    ${dest}`);
  }
  console.log('\n  Done (~$0.12). The three samples should be unmistakably the same person.\n');
  await pool.end();
})().catch((e) => { console.error('\n  x', e.message, '\n'); process.exit(1); });
