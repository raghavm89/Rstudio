"use strict";

/**
 * Shared catalogue — browse, select, publish.
 *
 * A catalogue entry is an `avatars` row with is_catalogue = true, owned by a
 * platform tenant and fully built (active LoRA + look profile + calibration
 * baselines). It is SHARED: any tenant may browse it, and after SELECTING it a
 * tenant may shoot against it. Selecting records a pointer, not a claim
 * (offering-frozen-spec.md §1) — many tenants can point at the same avatar and
 * nothing is retired.
 *
 * The generation-authorisation rule for a catalogue avatar lives in
 * orchestrator.createShoot (a tenant may shoot an avatar it owns OR a catalogue
 * avatar it has selected). This module owns browse, select and publish only; it
 * never relaxes tenant scope for anything but is_catalogue rows.
 */

const StudioUsage = require("../../models/studioUsage");

const Catalogue = {
  /**
   * Every published catalogue avatar, newest first, optional region filter.
   * Cross-tenant on purpose — but the WHERE pins is_catalogue, so a private
   * avatar can never leak out of this query however the caller filters.
   */
  async listPublished(client, { region = null } = {}) {
    const { rows } = await client.query(
      `SELECT a.id, a.slug, a.name, a.catalogue_region AS region,
              a.identity_block, a.disclosure_line,
              a.voice_provider, a.voice_id,
              (l.id IS NOT NULL) AS ready,
              a.catalogue_published_at
         FROM avatars a
         LEFT JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
        WHERE a.is_catalogue
          AND ($1::text IS NULL OR a.catalogue_region = $1)
        ORDER BY a.catalogue_published_at DESC NULLS LAST, a.id`,
      [region]
    );
    return rows;
  },

  async getPublished(client, id) {
    const { rows } = await client.query(
      `SELECT a.*, (l.id IS NOT NULL) AS ready
         FROM avatars a
         LEFT JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
        WHERE a.id = $1 AND a.is_catalogue`,
      [Number(id)]
    );
    return rows[0] || null;
  },

  async selectionsFor(client, tenantId) {
    const { rows } = await client.query(
      `SELECT s.avatar_id, s.selected_at,
              a.slug, a.name, a.catalogue_region AS region, a.identity_block
         FROM catalogue_selections s
         JOIN avatars a ON a.id = s.avatar_id
        WHERE s.tenant_id = $1
        ORDER BY s.selected_at DESC`,
      [tenantId]
    );
    return rows;
  },

  /**
   * Adopt a catalogue avatar for a tenant.
   *
   * Idempotent on (tenant, avatar): selecting the same one twice is a no-op that
   * reports alreadyHad, not a duplicate-key error. A selection consumes a plan
   * avatar slot (Free/Catalogue = 1) but costs nothing to build — the avatar was
   * built once by the platform. The slot check counts owned avatars plus
   * existing selections against the plan's lifetime avatar limit.
   */
  async select(client, { tenantId, userId = null, avatarId }) {
    const cat = await this.getPublished(client, avatarId);
    if (!cat) {
      const e = new Error("No such catalogue avatar");
      e.status = 404;
      throw e;
    }
    if (!cat.ready) {
      const e = new Error("This catalogue avatar has no trained model yet");
      e.status = 409;
      e.code = "NOT_READY";
      throw e;
    }

    const existing = await client.query(
      `SELECT id, avatar_id, selected_at
         FROM catalogue_selections WHERE tenant_id = $1 AND avatar_id = $2`,
      [tenantId, avatarId]
    );
    if (existing.rows[0]) return { selection: existing.rows[0], alreadyHad: true };

    const limit = await StudioUsage.limitFor(client, tenantId, "avatars", "lifetime");
    const { rows: used } = await client.query(
      `SELECT (SELECT COUNT(*) FROM avatars
                WHERE tenant_id = $1 AND NOT is_catalogue)
            + (SELECT COUNT(*) FROM catalogue_selections WHERE tenant_id = $1)
              AS n`,
      [tenantId]
    );
    if (Number(used[0].n) >= Number(limit)) {
      const e = new Error("Your plan has no free avatar slot for another selection");
      e.status = 402;
      e.code = "AVATAR_LIMIT";
      throw e;
    }

    const { rows } = await client.query(
      `INSERT INTO catalogue_selections (tenant_id, avatar_id, selected_by)
       VALUES ($1, $2, $3)
       RETURNING id, avatar_id, selected_at`,
      [tenantId, avatarId, userId]
    );
    return { selection: rows[0], alreadyHad: false };
  },

  /**
   * Publish a fully-built avatar into the shared catalogue. A platform action:
   * a catalogue avatar must be generatable the instant a customer picks it, so
   * this refuses unless the avatar is synthetic and has an active LoRA, a look
   * profile and at least one calibration baseline. A twin (a real person) can
   * never be a catalogue face.
   */
  async publish(client, { avatarId, region = null }) {
    const { rows } = await client.query(
      `SELECT a.id, a.mode,
              (SELECT id FROM avatar_loras WHERE avatar_id = a.id AND active) AS lora_id,
              (SELECT avatar_id FROM look_profiles WHERE avatar_id = a.id)   AS has_look,
              (SELECT COUNT(*) FROM expression_baselines WHERE avatar_id = a.id)::int AS baselines
         FROM avatars a WHERE a.id = $1`,
      [Number(avatarId)]
    );
    const a = rows[0];
    if (!a) {
      const e = new Error("No such avatar");
      e.status = 404;
      throw e;
    }
    if (a.mode !== "synthetic") {
      const e = new Error("Only synthetic avatars can be catalogue faces");
      e.status = 409;
      e.code = "NOT_SYNTHETIC";
      throw e;
    }
    if (!a.lora_id) {
      const e = new Error("Avatar has no active LoRA");
      e.status = 409;
      e.code = "NOT_TRAINED";
      throw e;
    }
    if (!a.has_look) {
      const e = new Error("Avatar has no look profile");
      e.status = 409;
      e.code = "NO_LOOK";
      throw e;
    }
    if (a.baselines < 1) {
      const e = new Error("Avatar has no calibration baselines");
      e.status = 409;
      e.code = "NOT_CALIBRATED";
      throw e;
    }

    const { rows: upd } = await client.query(
      `UPDATE avatars
          SET is_catalogue           = TRUE,
              catalogue_region       = COALESCE($2, catalogue_region),
              catalogue_published_at = NOW()
        WHERE id = $1
        RETURNING id, slug, name, catalogue_region, catalogue_published_at`,
      [Number(avatarId), region]
    );
    return upd[0];
  },

  // ── Admin: manage the catalogue ───────────────────────────────────────────

  /** Everything in the catalogue (with adoption counts) + everything that
   *  COULD be published: a synthetic avatar with an active LoRA, a look profile
   *  and at least one calibration baseline that is not already a catalogue face. */
  async adminList(client) {
    const { rows: catalogue } = await client.query(
      `SELECT a.id, a.slug, a.name, a.tenant_id, a.catalogue_region AS region,
              a.catalogue_published_at,
              (SELECT COUNT(*)::int FROM catalogue_selections s WHERE s.avatar_id = a.id) AS selections
         FROM avatars a
        WHERE a.is_catalogue
        ORDER BY a.catalogue_published_at DESC NULLS LAST, a.id`
    );
    const { rows: publishable } = await client.query(
      `SELECT a.id, a.slug, a.name, a.tenant_id
         FROM avatars a
        WHERE NOT a.is_catalogue
          AND a.mode = 'synthetic'
          AND EXISTS (SELECT 1 FROM avatar_loras l WHERE l.avatar_id = a.id AND l.active)
          AND EXISTS (SELECT 1 FROM look_profiles lp WHERE lp.avatar_id = a.id)
          AND EXISTS (SELECT 1 FROM expression_baselines b WHERE b.avatar_id = a.id)
        ORDER BY a.id`
    );
    return { catalogue, publishable };
  },

  /** Remove an avatar from the catalogue. Reversible (the avatar and its LoRA
   *  stay; only the flag is cleared). Refuses while customers have selected it,
   *  so a face someone is posting with cannot vanish under them — unless force,
   *  which also drops those selections. */
  async unpublish(client, { avatarId, force = false }) {
    const { rows } = await client.query(
      `SELECT id, is_catalogue FROM avatars WHERE id = $1`, [Number(avatarId)]
    );
    const a = rows[0];
    if (!a) { const e = new Error("No such avatar"); e.status = 404; throw e; }
    if (!a.is_catalogue) return { removed: false, alreadyGone: true };

    const { rows: sel } = await client.query(
      `SELECT COUNT(*)::int n FROM catalogue_selections WHERE avatar_id = $1`, [Number(avatarId)]
    );
    const inUse = sel[0].n;
    if (inUse > 0 && !force) {
      const e = new Error(`${inUse} customer${inUse === 1 ? "" : "s"} have selected this avatar`);
      e.status = 409; e.code = "IN_USE"; e.selections = inUse; throw e;
    }
    if (force) {
      await client.query(`DELETE FROM catalogue_selections WHERE avatar_id = $1`, [Number(avatarId)]);
    }
    await client.query(
      `UPDATE avatars SET is_catalogue = FALSE, catalogue_published_at = NULL WHERE id = $1`,
      [Number(avatarId)]
    );
    return { removed: true, hadSelections: inUse };
  },
};

module.exports = Catalogue;
