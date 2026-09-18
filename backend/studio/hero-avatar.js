#!/usr/bin/env node
'use strict';

/**
 * Generate a landing-page showcase set for ANY avatar — a generic hero-assets.
 *
 * hero-assets.js is hardcoded to Aanya (her trigger, wardrobe, locations), and
 * writes to frontend/public/hero/ — so it can only ever make Aanya's set. This
 * reads the avatar's frozen identity block + trigger from the DB, its WARDROBE
 * and LOCATIONS from its persona bible, and renders a poster + four setups into
 * frontend/public/hero/<slug>/ (its own folder — never touches Aanya's). Uses
 * fal's hosted LoRA copy from the training job, so no storage tunnel is needed.
 *
 *   node studio/hero-avatar.js --avatar 6 --lora-job 938
 *   node studio/hero-avatar.js --avatar rohan-mehra --lora-job 938 --wardrobe "a plain crew-neck tee"
 *
 * ~$0.20 for five stills. Runs on the Mac (DB + FAL_KEY).
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
  if (!res.ok) throw new Error(`fal HTTP ${res.status} re-reading job #${jobId} (expired? use a tunnel).`);
  const url = out.diffusers_lora_file && out.diffusers_lora_file.url;
  if (!url) throw new Error('That training result has no diffusers_lora_file url.');
  return url;
}

/** Pull the first wardrobe silhouette and first two locations out of a persona bible. */
function fromBible(slug) {
  const p = path.join(__dirname, 'personas', slug, 'persona.md');
  let wardrobe = null; const locations = [];
  try {
    const t = fs.readFileSync(p, 'utf8');
    const ward = t.match(/##\s*Wardrobe rules[\s\S]*?\n\s*1\.\s*([^\n]+)/i);
    if (ward) wardrobe = ward[1].replace(/\*\*/g, '').trim().toLowerCase();
    const locBlock = (t.split(/##\s*Locations/i)[1] || '').split(/\n##\s/)[0];
    const re = /^\s*\d+\.\s*\*\*`[^`]+`\*\*\s*[—-]\s*([^\n]+)/gim;
    let m;
    while ((m = re.exec(locBlock)) && locations.length < 3) {
      locations.push(m[1].replace(/\*\*/g, '').trim());
    }
  } catch (_) { /* fall back to generics */ }
  return { wardrobe, locations };
}

async function run(input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${MODEL}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
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

(async () => {
  if (!KEY) { console.error('FAL_KEY is not set (backend .env).'); process.exit(1); }
  const who = flag('avatar');
  if (!who) { console.error('Usage: node studio/hero-avatar.js --avatar <id|slug> --lora-job <trainJobId> [--wardrobe "..."] [--scale 1.0]'); process.exit(1); }
  const scale = Number(flag('scale', 1.0));
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

  const bible = fromBible(av.slug);
  const wardrobe = flag('wardrobe', bible.wardrobe) || 'a plain, well-fitted everyday outfit';
  const locA = flag('location', bible.locations[0]) || 'a bright, simple interior with soft daylight';
  const locB = bible.locations[1] || locA;

  const SETUPS = [
    ['poster',  `medium portrait, head and chest, ${wardrobe}, in ${locA}, looking to camera, confident and relaxed`],
    ['close',   `tight close-up portrait, head and shoulders, face fills the frame, ${wardrobe}, in ${locA}`],
    ['medium',  `medium shot, head to waist, three-quarter angle, ${wardrobe}, in ${locB}, looking just past the camera`],
    ['full',    `full-length wide shot, the whole body head to feet standing, ${wardrobe}, in ${locB}`],
    ['cover',   `waist-up hero shot, ${wardrobe}, in ${locA}, warm natural light, a slight smile`],
  ];

  const outDir = path.join(__dirname, '..', '..', 'frontend', 'public', 'hero', av.slug);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  Showcase for ${av.name} (#${av.id}) — trigger ${av.lora_trigger}, scale ${scale}`);
  console.log(`  wardrobe: ${wardrobe}`);
  console.log(`  location: ${locA}`);
  console.log(`  out ${outDir}\n`);

  const manifest = { avatar: av.slug, name: av.name, setups: [] };
  for (const [key, scene] of SETUPS) {
    const prompt = `${av.lora_trigger}, ${av.identity_block}, ${scene}, natural relaxed expression, `
      + 'candid photograph, soft natural daylight, sharp focus, realistic skin texture with visible pores';
    const out = await run({ prompt, image_size: { width: W, height: H }, num_images: 1, guidance_scale: 3.5, loras: [{ path: loraUrl, scale }] }, key);
    const url = out.images && out.images[0] && out.images[0].url;
    if (!url) { console.log('    (no image)'); continue; }
    const file = `${key}.jpg`;
    await download(url, path.join(outDir, file));
    manifest.setups.push({ key, file });
    console.log(`    ${path.join(av.slug, file)}`);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n  Done (~$0.20). Showcase set in frontend/public/hero/${av.slug}/.\n`);
  await pool.end();
})().catch((e) => { console.error('\n  x', e.message, '\n'); process.exit(1); });
