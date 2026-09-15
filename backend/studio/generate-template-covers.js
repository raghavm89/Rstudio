#!/usr/bin/env node
'use strict';

/**
 * Give the platform template library real preview images — one Aanya still per
 * template, so a template shows what it makes (like an avatar shows its face)
 * instead of a ► / ▦ glyph.
 *
 * ── Why a script you run yourself ────────────────────────────────────────────
 * Same reason as hero-assets.js: neither sandbox that built this can reach
 * fal.ai, and the DB lives on this Mac. So this runs in your Terminal:
 *
 *     DB_NAME=rstudio_db node studio/generate-template-covers.js            # plan + price, spends nothing
 *     DB_NAME=rstudio_db node studio/generate-template-covers.js --yes      # actually renders + spends
 *
 * It reuses the REAL prompt pipeline (buildWorkflow) with the avatar's active
 * LoRA and look, renders one frame per template on fal's flux-lora, writes it to
 * frontend/public/templates/<slug>.jpg, and sets content_templates.cover_url to
 * /templates/<slug>.jpg (served by Next directly — no proxy, no ngrok).
 *
 * Flags:
 *     --avatar <id|slug>   whose face to use (default: aanya-kapoor, else the
 *                          first avatar with an active LoRA + look profile)
 *     --only <slug,slug>   only these template slugs
 *     --scale <n>          LoRA scale (default 0.95, matches the pipeline)
 *     --steps <n>          inference steps (default 32)
 *     --force              regenerate even templates that already have a cover
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/config/db'));
const { buildWorkflow, WorkflowError } = require(path.join(ROOT, 'src/services/studio/comfyui/buildWorkflow'));
const { FalProvider } = require(path.join(ROOT, 'worker/providers/fal'));
const { createStorage } = require(path.join(ROOT, 'src/services/studio/storageFactory'));

const OUT_DIR = path.join(ROOT, '..', 'frontend', 'public', 'templates');
const PUBLIC_PREFIX = '/templates';
const API = 'https://queue.fal.run';
const LORA_MODEL = process.env.FAL_STILL_MODEL || 'fal-ai/flux-lora';
const KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const CENTS_PER_MP = Number(process.env.FAL_PRICE_STILL_CENTS ?? 3.5);

const args = process.argv.slice(2);
const flag = (name, fb = null) => { const i = args.indexOf(`--${name}`); if (i === -1) return fb; const n = args[i + 1]; return n && !n.startsWith('--') ? n : true; };
const CONFIRMED = args.includes('--yes');
const FORCE = args.includes('--force');
const AVATAR = flag('avatar', 'aanya-kapoor');
const ONLY = flag('only', null);
const ONLY_SET = ONLY ? String(ONLY).split(',').map((s) => s.trim()).filter(Boolean) : null;
const LORA_SCALE = Number(flag('scale', 0.95));
const STEPS = Number(flag('steps', 32));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' });

async function run(model, input, label) {
  process.stdout.write(`  ${label}… `);
  const submit = await fetch(`${API}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const hint = submit.status === 401 ? 'FAL_KEY is not valid.' : submit.status === 403 ? 'Key valid but rejected — usually zero credits or no access.' : '';
    throw new Error(`${model} → HTTP ${submit.status}. ${hint} ${JSON.stringify(queued).slice(0, 200)}`);
  }
  const statusUrl = queued.status_url, responseUrl = queued.response_url;
  if (!statusUrl) throw new Error(`No status_url: ${JSON.stringify(queued).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await (await fetch(statusUrl, { headers: headers() })).json().catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`${model} failed: ${JSON.stringify(st.error || st).slice(0, 300)}`);
    if (Date.now() - t0 > 8 * 60 * 1000) throw new Error(`${model} timed out`);
    process.stdout.write('.');
  }
  const r = await fetch(responseUrl, { headers: headers() });
  const out = await r.json();
  if (!r.ok) throw new Error(`${model} result HTTP ${r.status}`);
  if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts.some(Boolean)) {
    throw new Error(`${model} refused the prompt on content policy (still billed).`);
  }
  console.log(`done (${Math.round((Date.now() - t0) / 1000)}s)`);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function loadAvatar() {
  const byId = /^\d+$/.test(String(AVATAR));
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.tenant_id, a.identity_block, a.avoid_block, a.subject_type,
            l.id AS lora_id, l.file_path, l.trigger_token, l.base_checkpoint,
            lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
            lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version
       FROM avatars a
       LEFT JOIN avatar_loras  l  ON l.avatar_id = a.id AND l.active
       LEFT JOIN look_profiles lp ON lp.avatar_id = a.id
      WHERE ${byId ? 'a.id = $1' : 'a.slug = $1'}
      ORDER BY (l.id IS NOT NULL) DESC, a.id
      LIMIT 1`,
    [byId ? Number(AVATAR) : String(AVATAR)]
  );
  let row = rows[0];
  if (!row) {
    // Fallback: any avatar with an active LoRA + look profile.
    const alt = await pool.query(
      `SELECT a.id, a.slug, a.tenant_id, a.identity_block, a.avoid_block, a.subject_type,
              l.id AS lora_id, l.file_path, l.trigger_token, l.base_checkpoint,
              lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
              lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version
         FROM avatars a JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
         JOIN look_profiles lp ON lp.avatar_id = a.id ORDER BY a.id LIMIT 1`);
    row = alt.rows[0];
  }
  if (!row) throw new Error('No avatar found. Pass --avatar <id|slug>.');
  if (!row.lora_id) throw new Error(`Avatar ${row.slug} has no active LoRA — train + activate it first.`);
  if (row.subject_type === 'character') throw new Error('Covers use a person avatar (Aanya). A character avatar is not supported here.');
  if (!row.base_look) throw new Error(`Avatar ${row.slug} has no look profile.`);
  return row;
}

async function resolveLoraUrl(filePath) {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  // Same as the render pipeline: hand fal the storage layer's PUBLIC URL so it
  // FETCHES the LoRA. The trained LoRA is ~131 MB, over fal's ~94 MB
  // direct-upload wall, so uploading is not an option — this is why shoots serve
  // it by URL. Requires STUDIO_PUBLIC_BASE to point at a host fal can reach (the
  // same tunnel/bucket the live shoots use).
  const url = createStorage().readUrl(filePath);
  if (!/^https?:\/\//i.test(String(url))) {
    throw new Error(`The LoRA must be served by a public URL fal can fetch, but the storage layer returned "${url}". `
      + 'Set STUDIO_PUBLIC_BASE in .env to the same URL your running shoots use, then re-run.');
  }
  return url;
}

/** Pick the shot that makes the most inviting cover: a friendly face, framed close-ish. */
function coverShot(recipe) {
  const shots = Array.isArray(recipe.shots) ? recipe.shots : [];
  if (!shots.length) return {};
  const goodExpr = new Set(['soft_smile', 'confident', 'laughing', 'happy']);
  const goodFrame = new Set(['close', 'medium']);
  return shots.find((s) => goodExpr.has(s.expression_key) && goodFrame.has(s.framing))
      || shots.find((s) => goodExpr.has(s.expression_key))
      || shots[0];
}

async function main() {
  if (!KEY) { console.error('FAL_KEY is not set (read from backend .env).'); process.exit(1); }

  const avatar = await loadAvatar();
  const { rows: vocabulary } = await pool.query(
    'SELECT facet, option_key, fragment FROM prompt_vocabulary WHERE version = $1 AND active',
    [avatar.vocabulary_version]
  );
  if (!vocabulary.length) throw new Error(`No active prompt_vocabulary for version ${avatar.vocabulary_version}`);

  // The same closed-vocabulary clamp createShoot uses: a seeded template may
  // carry a facet value the vocabulary never defined (e.g. light_direction
  // "window" / "backlit"). The live pipeline clamps those to a safe fallback at
  // shoot time; buildWorkflow called directly would instead throw, so clamp here
  // too — otherwise a stale template renders no cover.
  const vocabByFacet = {};
  for (const r of vocabulary) (vocabByFacet[r.facet] = vocabByFacet[r.facet] || new Set()).add(r.option_key);
  const clamp = (facet, val, fb) => (val && vocabByFacet[facet] && vocabByFacet[facet].has(val)) ? val : fb;

  const { rows: templates } = await pool.query(
    `SELECT id, slug, name, kind, recipe, cover_url FROM content_templates
      WHERE is_platform = TRUE ${FORCE ? '' : 'AND cover_url IS NULL'}
      ORDER BY id`
  );
  let todo = templates;
  if (ONLY_SET) todo = todo.filter((t) => ONLY_SET.includes(t.slug));
  if (!todo.length) { console.log('\nNothing to do — every template already has a cover (use --force to redo).\n'); await pool.end(); return; }

  const perCents = Math.ceil((880 * 1104) / 1e6) * CENTS_PER_MP; // 1 MP, billed up
  console.log(`\nTemplate covers — one ${avatar.slug} still each\n`);
  console.log(`  Avatar   ${avatar.slug} (LoRA #${avatar.lora_id})`);
  console.log(`  Model    ${LORA_MODEL}  ·  scale ${LORA_SCALE}  ·  ${STEPS} steps`);
  console.log(`  Output   frontend/public/templates/<slug>.jpg  →  cover_url ${PUBLIC_PREFIX}/<slug>.jpg`);
  console.log(`  Count    ${todo.length} template${todo.length === 1 ? '' : 's'}${FORCE ? ' (--force)' : ''}: ${todo.map((t) => t.slug).join(', ')}`);
  console.log(`  Cost     ~$${((perCents * todo.length) / 100).toFixed(2)}  ($${(perCents / 100).toFixed(3)} each)\n`);
  if (!CONFIRMED) { console.log('  Nothing spent. Re-run with --yes to render.\n'); await pool.end(); return; }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const loraUrl = await resolveLoraUrl(avatar.file_path);

  let ok = 0, failed = 0;
  for (const t of todo) {
    const recipe = t.recipe || {};
    const shot = coverShot(recipe);
    const scene = recipe.scene || {};
    const cont = scene.continuity || {};
    let built;
    try {
      built = buildWorkflow({
        avatar: { slug: avatar.slug, identity_block: avatar.identity_block, avoid_block: avatar.avoid_block },
        lora: { file_path: avatar.file_path, trigger_token: avatar.trigger_token, base_checkpoint: avatar.base_checkpoint },
        lookProfile: {
          base_look: avatar.base_look, lens: avatar.lens, colour: avatar.colour, grain: avatar.grain,
          skin: avatar.skin, natural_asymmetry: avatar.natural_asymmetry, hair_detail: avatar.hair_detail,
        },
        shot: {
          framing: clamp('framing', shot.framing, 'medium'),
          light_direction: clamp('light_direction', shot.light_direction, 'camera_left'),
          light_quality: clamp('light_quality', shot.light_quality, 'soft'),
          expression_key: clamp('expression', shot.expression_key, 'soft_smile'),
          pose_key: shot.pose_key || null, advanced_append: shot.advanced_append || null,
        },
        scene: { location_key: scene.location_key || null, time_of_day: clamp('time_of_day', scene.time_of_day, 'afternoon') },
        vocabulary,
        locationText: cont.location_text || '',
        wardrobeText: cont.wardrobe_text || '',
        quality: '1mp', backend: 'cuda',
        seed: Math.floor(Math.random() * 2000000000),
        filenamePrefix: `studio/${avatar.slug}/template-cover/${t.slug}`,
      });
    } catch (err) {
      if (err instanceof WorkflowError) { console.log(`  ✗ ${t.slug}: prompt assembly failed — ${err.message}`); failed++; continue; }
      throw err;
    }

    try {
      const out = await run(LORA_MODEL, {
        prompt: built.prompt,
        image_size: { width: built.width, height: built.height },
        num_images: 1, num_inference_steps: STEPS, guidance_scale: 3.5,
        enable_safety_checker: true, output_format: 'jpeg',
        loras: [{ path: loraUrl, scale: LORA_SCALE }],
      }, t.slug.padEnd(24));
      const url = out.images?.[0]?.url;
      if (!url) { console.log(`    ! ${t.slug} produced no image — skipping`); failed++; continue; }
      const dest = path.join(OUT_DIR, `${t.slug}.jpg`);
      await download(url, dest);
      const coverUrl = `${PUBLIC_PREFIX}/${t.slug}.jpg`;
      await pool.query('UPDATE content_templates SET cover_url = $2, updated_at = NOW() WHERE id = $1', [t.id, coverUrl]);
      ok++;
    } catch (err) {
      console.log(`  ✗ ${t.slug}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n  Done — ${ok} cover${ok === 1 ? '' : 's'} written${failed ? `, ${failed} failed` : ''}.`);
  console.log(`  Files in frontend/public/templates/ ; cover_url set on each template.\n`);
  await pool.end();
}

main().catch((err) => { console.error('\n  ✗', err.message, '\n'); process.exit(1); });
