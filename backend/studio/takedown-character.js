#!/usr/bin/env node
'use strict';

/**
 * Take down a character built from an uploaded image (mode 3).
 *
 *   node studio/takedown-character.js --avatar <id> --reason "trademark complaint"       # dry run
 *   node studio/takedown-character.js --avatar <id> --reason "trademark complaint" --yes # apply
 *   node studio/takedown-character.js --attestation <id> --reason "..." --yes
 *
 * The notice-and-takedown path the IT Rules 2026 require (inside the 3-hour
 * window). Deactivates the rights attestation and, with it, the derived avatar:
 * the avatar is retired and its active LoRA deactivated, so nothing further
 * generates from the disputed upload. The record is NOT deleted — the log has to
 * outlive the content it describes.
 *
 * An admin can also do this in-app (POST /admin/character-attestations/:id/takedown);
 * this is the operator equivalent for when there is no console in front of you.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const pool = require(path.join(ROOT, 'src/config/db'));
const CharacterAttestation = require(path.join(ROOT, 'src/services/studio/characterAttestation'));

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const AVATAR = flag('--avatar') ? Number(flag('--avatar')) : null;
const ATTESTATION = flag('--attestation') ? Number(flag('--attestation')) : null;
const REASON = flag('--reason');
const APPLY = argv.includes('--yes');

const die = (m) => { console.error(`\n  x ${m}\n`); process.exit(1); };

async function main() {
  if (!AVATAR && !ATTESTATION) die('Give --avatar <id> or --attestation <id>');

  // Show what will be disabled first.
  const { rows } = await pool.query(
    `SELECT ca.id AS attestation_id, ca.active, ca.avatar_id, a.name, a.slug, a.status
       FROM character_attestations ca JOIN avatars a ON a.id = ca.avatar_id
      WHERE ${ATTESTATION ? 'ca.id = $1' : 'a.id = $1'}
      ORDER BY ca.active DESC, ca.created_at DESC LIMIT 1`,
    [ATTESTATION || AVATAR]);
  const row = rows[0];
  if (!row) die('No attestation found for that target.');

  console.log(`\n  Avatar #${row.avatar_id} — ${row.name} (${row.slug}), status ${row.status}`);
  console.log(`  Attestation #${row.attestation_id} — ${row.active ? 'ACTIVE' : 'already inactive'}`);
  if (REASON) console.log(`  Reason: ${REASON}`);

  if (!APPLY) {
    console.log('\n  (dry run — pass --yes to retire the avatar and deactivate its model)\n');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await CharacterAttestation.takedown(client, {
      attestationId: ATTESTATION || undefined, avatarId: AVATAR || undefined,
      reason: REASON, by: null,
    });
    await client.query('COMMIT');
    console.log(`\n  ✓ Attestation #${out.attestationId} deactivated; avatar #${out.avatarId} retired and its model pulled.\n`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    die(`Takedown failed: ${e.message}`);
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
