#!/usr/bin/env node
'use strict';

/**
 * Give an avatar a display photo (the card/catalogue thumbnail).
 *
 * The avatars card and catalogue browse read `preview_url` from the newest
 * SELECTED `still`/`thumbnail` in studio_assets. An avatar built from on-disk
 * seed candidates (via seed-set) never ran a shoot, so it has no asset and shows
 * a blank card. This uploads a chosen image into studio storage and records it
 * as a selected still, so the photo appears everywhere Aanya's does.
 *
 *   node studio/set-avatar-photo.js --avatar 6
 *   node studio/set-avatar-photo.js --avatar 6 --image frontend/public/hero/rohan-mehra/close.jpg
 *
 * Default image: frontend/public/hero/<slug>/poster.jpg. Runs on the Mac.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const { createStorage } = require(path.join(__dirname, '..', 'src', 'services', 'studio', 'storageFactory'));

const flag = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

async function storeImage(storage, { tenantId, avatarSlug, filename, buf }) {
  const args = { tenantId, avatarSlug, projectId: 'preview', kind: 'preview', filename, contentType: 'image/jpeg' };
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
  const who = flag('avatar');
  if (!who) { console.error('Usage: node studio/set-avatar-photo.js --avatar <id|slug> [--image <path>]'); process.exit(1); }
  const byId = /^\d+$/.test(String(who));
  const { rows } = await pool.query(
    `SELECT id, slug, name, tenant_id FROM avatars WHERE ${byId ? 'id = $1' : 'slug = $1'} LIMIT 1`,
    [byId ? Number(who) : who]
  );
  const av = rows[0];
  if (!av) { console.error(`No avatar "${who}".`); process.exit(1); }

  const imgPath = flag('image', path.join(__dirname, '..', '..', 'frontend', 'public', 'hero', av.slug, 'poster.jpg'));
  if (!fs.existsSync(imgPath)) { console.error(`Image not found: ${imgPath}\n  Pass --image <path>.`); process.exit(1); }
  const buf = fs.readFileSync(imgPath);

  const storage = createStorage();
  const key = await storeImage(storage, { tenantId: av.tenant_id, avatarSlug: av.slug, filename: `preview-${Date.now()}.jpg`, buf });
  const storageUrl = storage.readUrl(key);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A single selected preview: clear any prior selected preview-kind stills, then insert.
    await client.query(
      `UPDATE studio_assets SET selected = FALSE
        WHERE avatar_id = $1 AND kind = 'still' AND project_id IS NULL AND selected = TRUE`,
      [av.id]
    );
    const { rows: [asset] } = await client.query(
      `INSERT INTO studio_assets (tenant_id, avatar_id, kind, storage_url, provider, qc_status, selected)
       VALUES ($1, $2, 'still', $3, 'fal', 'passed', TRUE) RETURNING id`,
      [av.tenant_id, av.id, storageUrl]
    );
    await client.query('COMMIT');
    console.log(`\n  ${av.name} (#${av.id}) photo set — asset #${asset.id}`);
    console.log(`  from ${path.relative(path.join(__dirname, '..', '..'), imgPath)}`);
    console.log(`  url  ${storageUrl}\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('  x insert failed:', e.message);
    process.exit(1);
  } finally { client.release(); }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
