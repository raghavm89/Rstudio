'use strict';

const pool = require('./../../config/db');

/**
 * The CAST of a multi-character story — resolve and validate every member once,
 * before a shoot is built or a credit is spent.
 *
 * A single-character shoot loads one avatar and threads its ids through every
 * job. A multi-character story (shot-reverse-shot: one character per shot, cut
 * together) needs the same for EACH member, plus the answer to "may this tenant
 * use this avatar at all". A member is usable when it is:
 *
 *   • the tenant's OWN avatar, or a CATALOGUE avatar the tenant has selected,
 *   • trained (an active LoRA) and set up (a look profile for a person, a style
 *     profile for a character), and
 *   • past its gate — a twin needs verified consent; an upload-origin character
 *     (mode 3) needs an active rights attestation.
 *
 * These are exactly the checks `orchestrator.createShoot` already makes for the
 * lead; this runs them for the whole cast in one query and reports the first
 * unusable member with a reason, so a story with a half-ready co-star is refused
 * cleanly instead of half-queued. See claude/scope-multi-character-story.md.
 */

class CastError extends Error {
  constructor(message, { status = 409, code = null, avatarId = null } = {}) {
    super(message);
    this.name = 'CastError';
    this.status = status;
    this.code = code;
    this.avatarId = avatarId;
  }
}

/**
 * Resolve a cast.
 *
 * @param client        a pg client/pool
 * @param tenantId
 * @param members       [{ key, avatarId, role? }] — key is the caller's label a
 *                      shot references ('lead', 'costar', a name); avatarId is
 *                      the avatar to use. Duplicates by avatarId are fine (two
 *                      keys can point at one avatar); each distinct avatar is
 *                      validated once.
 * @returns { byKey, byAvatar, list } resolved members:
 *          { key, avatarId, loraId, subjectType, voiceProvider, voiceId, name, slug, role, isCatalogue }
 */
async function resolve(client, { tenantId, members }) {
  const db = client || pool;
  if (!Array.isArray(members) || !members.length) {
    throw new CastError('A story needs at least one cast member', { status: 400, code: 'NO_CAST' });
  }
  for (const m of members) {
    if (!m || !Number.isFinite(Number(m.avatarId))) {
      throw new CastError('Every cast member needs an avatarId', { status: 400, code: 'BAD_MEMBER' });
    }
    if (!m.key || !String(m.key).trim()) {
      throw new CastError('Every cast member needs a key', { status: 400, code: 'NO_KEY' });
    }
  }

  const ids = [...new Set(members.map((m) => Number(m.avatarId)))];
  const { rows } = await db.query(
    `SELECT a.id, a.slug, a.name, a.mode, a.subject_type, a.character_source,
            a.voice_provider, a.voice_id, a.is_catalogue,
            l.id  AS lora_id,
            lp.avatar_id AS has_look_profile,
            sp.avatar_id AS has_style_profile,
            c.verified   AS consent_verified,
            att.id       AS attestation_active,
            sel.tenant_id AS selected_by_tenant
       FROM avatars a
       LEFT JOIN avatar_loras          l   ON l.avatar_id = a.id AND l.active
       LEFT JOIN look_profiles         lp  ON lp.avatar_id = a.id
       LEFT JOIN style_profiles        sp  ON sp.avatar_id = a.id
       LEFT JOIN consent_records       c   ON c.id = a.consent_record_id
       LEFT JOIN character_attestations att ON att.id = a.attestation_id AND att.active
       LEFT JOIN catalogue_selections  sel ON sel.avatar_id = a.id AND sel.tenant_id = $2
      WHERE a.id = ANY($1::int[])
        AND (a.tenant_id = $2 OR (a.is_catalogue AND sel.tenant_id = $2))`,
    [ids, tenantId]
  );

  const byId = new Map(rows.map((r) => [r.id, r]));

  // Validate each distinct avatar once, with the reason a person can act on.
  const resolvedById = new Map();
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) {
      throw new CastError(`Avatar ${id} is not in this workspace or catalogue`, { status: 404, code: 'NO_AVATAR', avatarId: id });
    }
    if (!a.lora_id) {
      throw new CastError(`${a.name} has no trained model yet`, { code: 'NO_LORA', avatarId: id });
    }
    const isCharacter = a.subject_type === 'character';
    const hasProfile = isCharacter ? a.has_style_profile : a.has_look_profile;
    if (!hasProfile) {
      throw new CastError(`${a.name} has no ${isCharacter ? 'style' : 'look'} profile yet`, { code: 'NO_PROFILE', avatarId: id });
    }
    if (a.mode !== 'synthetic' && !a.consent_verified) {
      throw new CastError(`${a.name} depicts a real person and has no verified consent record`, { status: 403, code: 'CONSENT_REQUIRED', avatarId: id });
    }
    if (isCharacter && a.character_source === 'upload' && !a.attestation_active) {
      throw new CastError(`${a.name} was built from an uploaded image and has no active rights attestation`, { status: 403, code: 'ATTESTATION_REQUIRED', avatarId: id });
    }
    resolvedById.set(id, {
      avatarId: id,
      loraId: a.lora_id,
      subjectType: a.subject_type,
      voiceProvider: a.voice_provider || null,
      voiceId: a.voice_id || null,
      name: a.name,
      slug: a.slug,
      isCatalogue: Boolean(a.is_catalogue && a.selected_by_tenant),
    });
  }

  // Map back onto the caller's keys (a key adds role; several keys may share an avatar).
  const byKey = new Map();
  const list = [];
  for (const m of members) {
    const base = resolvedById.get(Number(m.avatarId));
    const entry = { ...base, key: String(m.key), role: m.role || 'subject' };
    if (byKey.has(entry.key)) {
      throw new CastError(`Duplicate cast key "${entry.key}"`, { status: 400, code: 'DUP_KEY' });
    }
    byKey.set(entry.key, entry);
    list.push(entry);
  }

  const byAvatar = new Map(list.map((e) => [e.avatarId, e]));
  return { byKey, byAvatar, list, distinctAvatars: [...resolvedById.values()] };
}

module.exports = { resolve, CastError };
