'use strict';

const pool = require('./../../config/db');

/**
 * Character-upload attestation — the copyright counterpart to consent.
 *
 * Mode 3 lets a user UPLOAD an image to build a non-human character from
 * (decision-character-avatars-mode3.md). A character depicts nobody, so there is
 * no same-person consent to verify — the risk is instead that the upload is
 * someone else's mascot, cartoon or artwork. The answer the IT Rules 2026 ask
 * for is not a bare disclaimer but a LOGGED, indemnified path: a per-upload,
 * timestamped "I own or have the rights to this image" that is stored with the
 * exact wording shown, so liability lands where the assertion was made.
 *
 * This module produces and reads that record, and owns the takedown that
 * disables a derived avatar on a rights complaint. It is the character
 * equivalent of consent.js — same shape, no face match.
 *
 * NOT in scope, deliberately: the legal WORDING below is a starting point for an
 * Indian lawyer (T13), a launch prerequisite for the paid upload path. The
 * version columns exist precisely so a rewrite is a new version, not a lost
 * record.
 */

// ── The attestation wording (PLACEHOLDER — pending T13 legal sign-off) ────────
// Bump ATTESTATION_TEXT_VERSION whenever ATTESTATION_TEXT changes, so a record
// proves which wording the user actually agreed to. The draft mirrors
// decision-character-avatars-mode3.md.
const ATTESTATION_TEXT_VERSION = 1;
const ATTESTATION_TEXT =
  'I own this image, or I have all rights and permissions needed to use it. ' +
  'It is not a character, logo, mascot, artwork, or likeness owned by someone ' +
  'else that I don’t have permission to use. I understand this image will be ' +
  'used to generate a new AI character, and that I am responsible for the rights ' +
  'in what I upload.';

class AttestationError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'AttestationError';
    this.status = status;
    this.code = code;
  }
}

/** Load the avatar and assert it is an uploadable character in this tenant. */
async function loadCharacter(client, avatarId, tenantId) {
  const { rows } = await client.query(
    'SELECT id, slug, name, subject_type, mode, character_source, attestation_id FROM avatars WHERE id = $1 AND tenant_id = $2',
    [avatarId, tenantId]
  );
  const avatar = rows[0];
  if (!avatar) throw new AttestationError('No such avatar in this workspace', { status: 404, code: 'NO_AVATAR' });
  if (avatar.subject_type !== 'character') {
    throw new AttestationError('Only a character avatar can be built from an uploaded image', { status: 409, code: 'NOT_A_CHARACTER' });
  }
  return avatar;
}

const CharacterAttestation = {
  ATTESTATION_TEXT,
  ATTESTATION_TEXT_VERSION,
  AttestationError,

  /**
   * Record an attestation BEFORE the bytes are accepted.
   *
   * The order matters and is the whole point: the tick is logged first, then the
   * caller hands back an upload target. `uploadRef` is the storage key the bytes
   * will land at; `sourceHash` is filled in later by ingest, once the file
   * exists (a hash of bytes that do not exist yet cannot be computed here, and
   * the record must not wait on the upload to be written).
   *
   * Marks the avatar `character_source = 'upload'` and points `attestation_id`
   * at this row, so the generate/train gate and takedown can find it.
   */
  async record(client, { tenantId, avatarId, userId = null, uploadRef = null, ip = null, userAgent = null, attested }) {
    if (attested !== true) {
      throw new AttestationError('The rights attestation must be accepted before uploading', { status: 400, code: 'NOT_ATTESTED' });
    }
    const avatar = await loadCharacter(client, avatarId, tenantId);

    const { rows } = await client.query(
      `INSERT INTO character_attestations
         (tenant_id, avatar_id, user_id, upload_ref, attestation_text_version, attested_text, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId, avatarId, userId, uploadRef, ATTESTATION_TEXT_VERSION, ATTESTATION_TEXT, ip, userAgent]
    );
    const record = rows[0];

    await client.query(
      `UPDATE avatars SET character_source = 'upload', attestation_id = $1, updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3`,
      [record.id, avatarId, tenantId]
    );
    return record;
  },

  /** The current ACTIVE attestation for an avatar, or null. */
  async active(client, { avatarId, tenantId = null }) {
    const params = [avatarId];
    let sql = `SELECT ca.* FROM character_attestations ca
                JOIN avatars a ON a.attestation_id = ca.id
               WHERE a.id = $1 AND ca.active = TRUE`;
    if (tenantId != null) { sql += ' AND a.tenant_id = $2'; params.push(tenantId); }
    const { rows } = await client.query(sql, params);
    return rows[0] || null;
  },

  /**
   * Gate helper: throw unless an upload-origin character has an active
   * attestation. A template-origin character (or a person avatar) is never
   * gated here. Callers pass an avatar row that already knows its
   * subject_type + character_source, so this stays a pure check plus one read.
   */
  async requireActive(client, avatar) {
    if (!avatar) throw new AttestationError('Avatar not found', { status: 404, code: 'NO_AVATAR' });
    if (avatar.subject_type !== 'character' || avatar.character_source !== 'upload') return; // not gated
    const rec = await this.active(client, { avatarId: avatar.id });
    if (!rec) {
      throw new AttestationError(
        'This character was built from an uploaded image and has no active rights attestation',
        { status: 403, code: 'ATTESTATION_REQUIRED' }
      );
    }
    return rec;
  },

  /**
   * Fill in the source hash + the reference URL once the bytes exist (called by
   * ingest). Scoped to the avatar so one tenant cannot stamp another's record.
   */
  async recordUpload(client, { attestationId, sourceHash, uploadRef = null }) {
    await client.query(
      `UPDATE character_attestations
          SET source_hash = COALESCE($2, source_hash),
              upload_ref  = COALESCE($3, upload_ref)
        WHERE id = $1`,
      [attestationId, sourceHash, uploadRef]
    );
  },

  /**
   * Takedown — the notice-and-complaint path. Deactivates the attestation, and
   * with it the derived avatar: the avatar is retired and its active LoRA
   * deactivated, so nothing further generates from the disputed upload. Records
   * are never deleted — the log has to outlive the content it describes.
   *
   * Idempotent-ish: taking down an already-inactive record still retires the
   * avatar and reports what it did, so a repeated complaint is safe.
   */
  async takedown(client, { attestationId = null, avatarId = null, tenantId = null, by = null, reason = null }) {
    let rec = null;
    if (attestationId) {
      const { rows } = await client.query('SELECT * FROM character_attestations WHERE id = $1', [attestationId]);
      rec = rows[0] || null;
    } else if (avatarId) {
      rec = await this.active(client, { avatarId, tenantId });
      if (!rec) {
        // Fall back to the avatar's linked record even if already inactive, so a
        // second takedown is still traceable.
        const { rows } = await client.query(
          `SELECT ca.* FROM character_attestations ca JOIN avatars a ON a.attestation_id = ca.id WHERE a.id = $1`, [avatarId]);
        rec = rows[0] || null;
      }
    }
    if (!rec) throw new AttestationError('No attestation to take down', { status: 404, code: 'NO_RECORD' });

    await client.query(
      `UPDATE character_attestations
          SET active = FALSE,
              taken_down_at = COALESCE(taken_down_at, NOW()),
              taken_down_by = $2,
              taken_down_reason = COALESCE($3, taken_down_reason)
        WHERE id = $1`,
      [rec.id, by, reason]
    );
    // Retire the avatar and pull any active model — the derived character must
    // stop being usable the moment the upload is disputed.
    await client.query(`UPDATE avatars SET status = 'retired', updated_at = NOW() WHERE id = $1`, [rec.avatar_id]);
    await client.query(`UPDATE avatar_loras SET active = FALSE WHERE avatar_id = $1 AND active`, [rec.avatar_id]);

    return { attestationId: rec.id, avatarId: rec.avatar_id, retired: true };
  },
};

module.exports = CharacterAttestation;
