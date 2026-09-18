#!/usr/bin/env node
'use strict';

/**
 * Register the ZoQ mascot as a CHARACTER catalogue avatar.
 *
 * The mascot has a trained LoRA (studio/loras/zoqmascot.safetensors) but was
 * never an avatar. This creates the avatar (subject_type=character, template),
 * uploads its LoRA into studio storage and activates it, writes a style profile
 * (characters QC on CLIP + style, not a look profile), and publishes it to the
 * shared catalogue — on the permissive CLIP floor, so it is usable now; CA5
 * calibration (studio/measure-clip-baseline.js) can tighten QC later.
 *
 *   node studio/register-mascot.js            # dry run
 *   node studio/register-mascot.js --yes      # do it
 *   node studio/register-mascot.js --yes --tenant 1 --lora studio/loras/zoqmascot.safetensors
 *
 * Runs on the Mac (DB + studio storage).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const { createStorage } = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'storageFactory'));
const Catalogue = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'catalogue'));

const flag = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--yes');

const SLUG = 'zoq-mascot';
const NAME = 'ZoQ Mascot';
const TRIGGER = 'zoqmascot';
const IDENTITY = 'cute chubby 3D cartoon squirrel mascot, warm reddish-brown fur, big round '
  + 'expressive eyes, big bushy tail, small violet-purple hoodie';
const AVOID = 'photorealistic human, extra limbs, deformed, text artifacts, watermark, flat sticker';
const STYLE = { render_style: 'soft_3d', palette: 'warm', line_weight: 'none', shading: 'soft', background: 'plain' };

async function storeLora(storage, { tenantId, slug, buf }) {
  const args = { tenantId, avatarSlug: slug, projectId: 'misc', kind: 'lora', filename: `${TRIGGER}.safetensors`, contentType: 'application/octet-stream' };
  if (typeof storage.pathFor === 'function') {
    const key = storage.keyFor(args);
    const full = storage.pathFor(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return key;
  }
  const t = storage.uploadTarget(args);
  const res = await fetch(t.url, { method: 'PUT', headers: t.headers, body: buf });
  if (!res.ok) throw new Error(`storage PUT failed HTTP ${res.status}`);
  return t.key;
}

(async () => {
  const tenantId = Number(flag('tenant', 1));
  const loraFile = flag('lora', path.join(__dirname, 'loras', `${TRIGGER}.safetensors`));
  if (!fs.existsSync(loraFile)) { console.error(`LoRA file not found: ${loraFile}`); process.exit(1); }
  const bytes = fs.statSync(loraFile).size;

  console.log(`\n  Register ${NAME} as a character catalogue avatar`);
  console.log(`    tenant   ${tenantId}`);
  console.log(`    slug     ${SLUG}   trigger ${TRIGGER}`);
  console.log(`    identity ${IDENTITY}`);
  console.log(`    style    ${Object.entries(STYLE).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`    LoRA     ${loraFile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  if (!APPLY) { console.log('\n  Dry run. Re-run with --yes to apply.\n'); await pool.end(); return; }

  const client = await pool.connect();
  let avatarId;
  try {
    await client.query('BEGIN');

    // 1) the avatar
    const { rows: av } = await client.query(
      `INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block,
                            lora_trigger, subject_type, character_source, disclosure_line)
       VALUES ($1,$2,$3,'synthetic','active',$4,$5,$6,'character','template',$7)
       ON CONFLICT (tenant_id, slug) DO UPDATE
         SET name = EXCLUDED.name, identity_block = EXCLUDED.identity_block,
             avoid_block = EXCLUDED.avoid_block, lora_trigger = EXCLUDED.lora_trigger,
             subject_type = 'character', character_source = 'template', status = 'active'
       RETURNING id`,
      [tenantId, SLUG, NAME, IDENTITY, AVOID, TRIGGER, 'AI-generated brand mascot']
    );
    avatarId = av[0].id;

    // 2) the LoRA — upload into studio storage, register + activate
    const storage = createStorage();
    const key = await storeLora(storage, { tenantId, slug: SLUG, buf: fs.readFileSync(loraFile) });
    await client.query('UPDATE avatar_loras SET active = FALSE WHERE avatar_id = $1', [avatarId]);
    await client.query(
      `INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint,
                                 network_rank, network_alpha, trained_at, active)
       VALUES ($1, 1, $2, $3, 'flux1-dev', 32, 16, NOW(), TRUE)
       ON CONFLICT (avatar_id, version) DO UPDATE
         SET file_path = EXCLUDED.file_path, active = TRUE, trained_at = NOW()`,
      [avatarId, key, TRIGGER]
    );

    // 3) the style profile (characters, not a look profile)
    await client.query(
      `INSERT INTO style_profiles (avatar_id, render_style, palette, line_weight, shading, background)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (avatar_id) DO UPDATE
         SET render_style = EXCLUDED.render_style, palette = EXCLUDED.palette,
             line_weight = EXCLUDED.line_weight, shading = EXCLUDED.shading,
             background = EXCLUDED.background, updated_at = NOW()`,
      [avatarId, STYLE.render_style, STYLE.palette, STYLE.line_weight, STYLE.shading, STYLE.background]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n  x failed, rolled back:', e.message, '\n');
    process.exit(1);
  } finally { client.release(); }

  // 4) publish to the catalogue (now character-aware)
  try {
    const pub = await Catalogue.publish(pool, { avatarId, region: flag('region', 'in') });
    console.log(`\n  ✅ ${NAME} (#${avatarId}) is in the catalogue (${pub.catalogue_region || 'no region'}).`);
    console.log('     It renders on the permissive CLIP floor. Give it a card photo:');
    console.log(`       node studio/set-avatar-photo.js --avatar ${avatarId} --image frontend/public/hero/mascot/creator.jpg`);
    console.log('     Then it shows in /stories cast-options and the catalogue.\n');
  } catch (e) {
    console.error(`\n  Registered as avatar #${avatarId}, but publish failed: ${e.message}`);
    console.error('  (Fix and re-run, or publish from Admin → Catalogue.)\n');
    process.exit(1);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
