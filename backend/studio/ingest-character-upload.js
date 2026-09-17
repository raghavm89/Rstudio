#!/usr/bin/env node
'use strict';

/**
 * Ingest an uploaded character reference image (mode 3) into the pipeline.
 *
 *   node studio/ingest-character-upload.js --avatar <id> --image ~/mango.png        # dry run
 *   node studio/ingest-character-upload.js --avatar <id> --image ~/mango.png --yes  # ingest
 *   node studio/ingest-character-upload.js --avatar <id> --from-upload --yes        # use the in-app upload
 *   node studio/ingest-character-upload.js --avatar <id> --images ~/refs --yes      # a folder
 *   --clip   also run the CLIP readability check (needs the torch env)
 *
 * A character built from an upload (decision-character-avatars-mode3.md) turns
 * that image into training material by storing it as the avatar's ANCHOR and
 * pointing anchor_candidate_id at it — then the normal "anchor and vary" seed
 * generation produces a pool conditioned on the upload. No fal here; this only
 * stages the reference.
 *
 * GATED ON THE ATTESTATION. Refuses unless an ACTIVE rights attestation exists
 * for the avatar (recorded in-app first, on the character-upload page). The tick
 * is the legal instrument; this is the step that acts on it.
 *
 * Runs on the machine with the database + storage (the Mac), like train.js.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const { createStorage } = require(path.join(ROOT, 'src/services/studio/storageFactory'));
const CharacterAttestation = require(path.join(ROOT, 'src/services/studio/characterAttestation'));
const { ingest } = require(path.join(ROOT, 'src/services/studio/characterUploadIngest'));

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const AVATAR = Number(flag('--avatar'));
const IMAGE = flag('--image');
const IMAGES = flag('--images');
const FROM_UPLOAD = argv.includes('--from-upload');
const USE_CLIP = argv.includes('--clip');
const APPLY = argv.includes('--yes');

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) die(`Could not read the uploaded image (HTTP ${res.status}) at ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function main() {
  if (!AVATAR) die('--avatar <id> is required');
  if (!IMAGE && !IMAGES && !FROM_UPLOAD) die('Give --image <file>, --images <dir>, or --from-upload');

  const { rows: av } = await pool.query(
    'SELECT id, tenant_id, slug, name, subject_type, character_source FROM avatars WHERE id = $1', [AVATAR]);
  const avatar = av[0];
  if (!avatar) die(`No avatar #${AVATAR}`);
  if (avatar.subject_type !== 'character') die(`Avatar #${AVATAR} (${avatar.name}) is not a character`);

  const attestation = await CharacterAttestation.active(pool, { avatarId: AVATAR, tenantId: avatar.tenant_id });
  if (!attestation) {
    die('No ACTIVE rights attestation for this character. The user must record the upload attestation in-app first.');
  }

  console.log(`\n  Avatar #${AVATAR} — ${avatar.name} (${avatar.slug})`);
  console.log(`  Attestation #${attestation.id} (v${attestation.attestation_text_version}) — active, recorded ${attestation.created_at}`);

  // Resolve the sources.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'char-upload-'));
  let sources = null;
  let dir = null;
  try {
    if (FROM_UPLOAD) {
      if (!attestation.upload_ref) die('The attestation has no upload_ref — nothing was uploaded to storage.');
      const url = createStorage().readUrl(attestation.upload_ref);
      const dest = path.join(tmpRoot, path.basename(attestation.upload_ref) || 'upload.png');
      await fetchToFile(url, dest);
      sources = [dest];
      console.log(`  Source: in-app upload → ${attestation.upload_ref}`);
    } else if (IMAGE) {
      if (!fs.existsSync(IMAGE)) die(`No such file: ${IMAGE}`);
      sources = [IMAGE];
      console.log(`  Source: ${IMAGE}`);
    } else {
      if (!fs.existsSync(IMAGES)) die(`No such folder: ${IMAGES}`);
      dir = IMAGES;
      console.log(`  Source: folder ${IMAGES}`);
    }

    if (!APPLY) {
      console.log('\n  (dry run — pass --yes to store the reference and set the anchor)\n');
      return;
    }

    let embedder = null;
    if (USE_CLIP) {
      const { ClipEmbedder } = require(path.join(ROOT, 'worker/clipEmbed'));
      embedder = new ClipEmbedder({});
    }
    try {
      const out = await ingest({
        avatarId: AVATAR, tenantId: avatar.tenant_id, sources, dir, embedder,
        onProgress: (m) => console.log(`  … ${m}`),
      });
      console.log(`\n  ✓ Anchor #${out.anchorId} set${out.pool ? `, +${out.pool} pool frame(s)` : ''}. `
        + `Attestation #${out.attestationId} stamped (sha256 ${String(out.anchorHash).slice(0, 12)}…).`);
      console.log('  Next: generate the pool (anchor-and-vary), cull, then studio/train.js.\n');
    } finally {
      if (embedder && embedder.stop) embedder.stop();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
