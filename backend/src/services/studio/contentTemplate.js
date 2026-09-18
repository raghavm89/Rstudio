'use strict';

const pool = require('../../config/db');
const Orchestrator = require('./orchestrator');

/**
 * Content templates — reusable ad / viral recipes applied onto an avatar.
 *
 * A template is a saved SHOOT recipe: a format (`kind`) + a `recipe` of
 * { brief, scene, shots }. Applying one IS a `Orchestrator.createShoot` with the
 * recipe's fields, so a template inherits every guard and cost the pipeline
 * already has — nothing here renders, charges or bypasses quota.
 *
 * Two sources (migration 059): PLATFORM templates (tenant_id NULL, is_platform)
 * that every tenant browses, and TENANT templates a user creates or saves from a
 * shoot. `list`/`get` return platform OR own; a private template never leaks to
 * another tenant, and `apply` reuses that same scoping so a tenant can only
 * shoot from a template it is allowed to see.
 */

// A category decides which formats are legal — an ad or a viral video is a reel
// or a short; viral stills are a post or a carousel.
const CATEGORY_KINDS = {
  ad_video:     ['reel', 'short'],
  viral_video:  ['reel', 'short'],
  viral_stills: ['post', 'carousel'],
};
const CATEGORIES = Object.keys(CATEGORY_KINDS);

class TemplateError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'TemplateError';
    this.status = status;
    this.code = code;
  }
}

const baseSlug = (name) =>
  String(name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'template';

/** A slug unique within the template's scope (a tenant's own, or the platform). */
async function uniqueSlug(client, tenantId, name) {
  const root = baseSlug(name);
  for (let i = 0; i < 50; i += 1) {
    const slug = i ? `${root}-${i + 1}` : root;
    const { rows } = await client.query(
      `SELECT 1 FROM content_templates
        WHERE slug = $1 AND tenant_id IS NOT DISTINCT FROM $2 LIMIT 1`,
      [slug, tenantId]
    );
    if (!rows[0]) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

const LIST_COLS =
  `id, tenant_id, slug, name, category, kind, frame_count, clip_seconds,
   cover_url, is_platform, status, (tenant_id IS NULL) AS platform, created_at, updated_at`;

const ContentTemplate = {
  CATEGORY_KINDS,
  CATEGORIES,
  TemplateError,

  /** Enforce the category↔kind rule with a message a person can act on. */
  assertCategoryKind(category, kind) {
    if (!CATEGORIES.includes(category)) {
      throw new TemplateError(`category must be one of ${CATEGORIES.join(', ')}`, { code: 'BAD_CATEGORY' });
    }
    if (!CATEGORY_KINDS[category].includes(kind)) {
      throw new TemplateError(
        `a ${category.replace('_', ' ')} template must be a ${CATEGORY_KINDS[category].join(' or ')}, not a ${kind}`,
        { code: 'BAD_KIND' }
      );
    }
  },

  /**
   * Platform library + this tenant's own, optionally filtered by category.
   * STORIES are excluded — they live in their own Story lane (listStories), not
   * in the Templates browse.
   */
  async list(client, tenantId, { category = null } = {}) {
    const { rows } = await client.query(
      `SELECT ${LIST_COLS} FROM content_templates
        WHERE (is_platform OR tenant_id = $1)
          AND is_story IS NOT TRUE
          AND ($2::text IS NULL OR category = $2)
        ORDER BY is_platform DESC, updated_at DESC, id DESC`,
      [tenantId, category]
    );
    return rows;
  },

  /** One template the tenant may see (platform or its own). Full recipe. */
  async get(client, tenantId, id) {
    const { rows } = await client.query(
      `SELECT * FROM content_templates WHERE id = $1 AND (is_platform OR tenant_id = $2)`,
      [Number(id), tenantId]
    );
    return rows[0] || null;
  },

  /** Create a tenant template from an explicit recipe. */
  async create(client, { tenantId, userId = null, name, category, kind, recipe = {}, coverUrl = null }) {
    if (!name || !String(name).trim()) throw new TemplateError('A template needs a name');
    this.assertCategoryKind(category, kind);

    const shots = Array.isArray(recipe.shots) ? recipe.shots : [];
    const frameCount = shots.length || Number(recipe.frame_count) || 4;
    if (frameCount < 1 || frameCount > 10) {
      throw new TemplateError('A template needs between 1 and 10 shots', { code: 'BAD_FRAME_COUNT' });
    }
    const clipSeconds = Math.min(10, Math.max(2, Number(recipe.clip_seconds) || 5));

    const slug = await uniqueSlug(client, tenantId, name);
    const { rows } = await client.query(
      `INSERT INTO content_templates
         (tenant_id, slug, name, category, kind, frame_count, clip_seconds, recipe, cover_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
      [tenantId, slug, String(name).trim(), category, kind, frameCount, clipSeconds,
       JSON.stringify(recipe), coverUrl, userId]
    );
    return rows[0];
  },

  /**
   * Save an existing shoot the tenant owns as a reusable template.
   *
   * Reads the project's scene and shots back out and freezes them into a recipe,
   * so "I liked this one — make it a template" needs no re-authoring. The shoot's
   * own `kind` must fit the chosen category.
   */
  async saveFromShoot(client, { tenantId, userId = null, projectId, name, category }) {
    const { rows: proj } = await client.query(
      `SELECT id, kind, slot_type, brief, trend_source
         FROM studio_projects WHERE id = $1 AND tenant_id = $2`,
      [Number(projectId), tenantId]
    );
    if (!proj[0]) throw new TemplateError('No such shoot', { status: 404 });
    const project = proj[0];
    this.assertCategoryKind(category, project.kind);

    const { rows: scenes } = await client.query(
      `SELECT location_key, time_of_day, continuity FROM studio_scenes WHERE project_id = $1 ORDER BY seq LIMIT 1`,
      [project.id]
    );
    const scene = scenes[0] || {};
    const { rows: shots } = await client.query(
      `SELECT s.framing, s.light_direction, s.light_quality, s.expression_key,
              s.expression_intensity, s.wardrobe_key, s.pose_key, s.advanced_append
         FROM studio_shots s
         JOIN studio_scenes sc ON sc.id = s.scene_id
        WHERE sc.project_id = $1 ORDER BY s.seq`,
      [project.id]
    );
    if (!shots.length) throw new TemplateError('That shoot has no shots to template', { status: 409 });

    // A cover, so a saved template previews what it makes (like an avatar shows
    // its face): the shoot's chosen still — the frame the human picked at review.
    const { rows: cov } = await client.query(
      `SELECT storage_url FROM studio_assets
        WHERE project_id = $1 AND kind = 'still' AND storage_url IS NOT NULL
          AND qc_status IS DISTINCT FROM 'superseded'
        ORDER BY selected DESC, created_at DESC LIMIT 1`,
      [project.id]
    );
    const coverUrl = cov[0] ? cov[0].storage_url : null;

    const recipe = {
      brief: { ...(project.brief || {}), slot_type: project.slot_type, trend_source: project.trend_source },
      scene: { location_key: scene.location_key, time_of_day: scene.time_of_day, continuity: scene.continuity || {} },
      shots,
      clip_seconds: 5,
    };
    return this.create(client, { tenantId, userId, name: name || `Template from shoot #${project.id}`, category, kind: project.kind, recipe, coverUrl });
  },

  /** Delete one of the tenant's OWN templates (never a platform one). */
  async remove(client, tenantId, id) {
    const { rowCount } = await client.query(
      `DELETE FROM content_templates WHERE id = $1 AND tenant_id = $2`,
      [Number(id), tenantId]
    );
    if (!rowCount) throw new TemplateError('No such template, or it is not yours to delete', { status: 404 });
    return true;
  },

  /** Admin: promote a template into the shared library. */
  async publish(client, id) {
    const { rows } = await client.query(
      `UPDATE content_templates SET is_platform = TRUE, status = 'ready', updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [Number(id)]
    );
    if (!rows[0]) throw new TemplateError('No such template', { status: 404 });
    return rows[0];
  },

  /**
   * Apply a template to an avatar — instantiate a shoot from its recipe.
   *
   * No `client`: `Orchestrator.createShoot` owns its own transaction (a
   * half-created shoot with quota reserved is worse than an error). The template
   * is fetched with the same platform-or-own scope as `get`, so a tenant cannot
   * apply a template it may not see. Every downstream refusal (no LoRA, no
   * profile, quota) surfaces from the orchestrator unchanged.
   */
  async apply({ tenantId, userId = null, templateId, avatarId, tier = 'free', idempotencyKey = null, intent = 'cloud' }) {
    const t = await this.get(pool, tenantId, templateId);
    if (!t) throw new TemplateError('No such template', { status: 404 });
    // A story is script + open roles — it is cast and created from the Story
    // library (applyStory), never applied onto a single lead avatar here.
    if (t.is_story) {
      throw new TemplateError('This is a story — cast and create it from the Story library', { status: 409, code: 'IS_STORY' });
    }
    const recipe = t.recipe || {};
    return Orchestrator.createShoot({
      tenantId,
      avatarId: Number(avatarId),
      userId,
      kind: t.kind,
      frameCount: t.frame_count,
      brief: recipe.brief || {},
      shots: Array.isArray(recipe.shots) ? recipe.shots : [],
      scene: recipe.scene || {},
      tier,
      clipSeconds: t.clip_seconds || 5,
      idempotencyKey,
      intent,
    });
  },

  /**
   * The roles of a story — the slots the user casts. From `recipe.roles`, or
   * derived from the distinct `character` keys the scenes reference. One role is
   * the lead (key 'lead'); `subject` ('any'|'person'|'character') only hints the
   * cast picker — any catalogue avatar may fill any role.
   */
  _storyRoles(recipe) {
    const r = recipe || {};
    if (Array.isArray(r.roles) && r.roles.length) {
      return r.roles.map((x) => ({
        key: String(x.key), label: x.label || x.key, hint: x.hint || null, subject: x.subject || 'any',
      }));
    }
    const keys = [];
    for (const sc of (r.scenes || [])) for (const sh of (sc.shots || [])) {
      const k = sh && sh.character ? String(sh.character) : 'lead';
      if (!keys.includes(k)) keys.push(k);
    }
    if (!keys.length) keys.push('lead');
    return keys.map((k) => ({ key: k, label: k === 'lead' ? 'Lead' : k, hint: null, subject: 'any' }));
  },

  /**
   * The Story library — platform stories + a tenant's own, each with its GENRE
   * and its open ROLES (the slots the user will cast). No dialogue is returned;
   * the list is a browse surface. The frontend groups by `genre`.
   */
  async listStories(client, tenantId) {
    const { rows } = await client.query(
      `SELECT id, tenant_id, slug, name, category, kind, genre, frame_count, clip_seconds,
              cover_url, is_platform, status, recipe, updated_at
         FROM content_templates
        WHERE is_story AND (is_platform OR tenant_id = $1)
        ORDER BY genre NULLS LAST, is_platform DESC, updated_at DESC, id DESC`,
      [tenantId]
    );
    return rows.map((r) => {
      const recipe = r.recipe || {};
      return {
        id: r.id, slug: r.slug, name: r.name, category: r.category, kind: r.kind,
        genre: r.genre || recipe.genre || 'other',
        frame_count: r.frame_count, clip_seconds: r.clip_seconds, cover_url: r.cover_url,
        is_platform: r.is_platform, platform: r.tenant_id == null, is_story: true, status: r.status,
        brief: { concept: (recipe.brief && recipe.brief.concept) || null, hook: (recipe.brief && recipe.brief.hook) || null },
        roles: this._storyRoles(recipe),
        scene_count: Array.isArray(recipe.scenes) ? recipe.scenes.length : 0,
        updated_at: r.updated_at,
      };
    });
  },

  /**
   * The avatars a story can be cast from: every catalogue avatar that is ready
   * (active LoRA), plus the tenant's own ready avatars — person OR character.
   * Each carries a preview so the picker can show a face.
   */
  async castOptions(client, tenantId) {
    const { rows } = await client.query(
      `SELECT a.id, a.slug, a.name, a.subject_type, a.is_catalogue,
              (SELECT s2.storage_url FROM studio_assets s2
                WHERE s2.avatar_id = a.id AND s2.kind IN ('still','thumbnail') AND s2.storage_url IS NOT NULL
                ORDER BY s2.selected DESC, s2.created_at DESC LIMIT 1) AS preview_url
         FROM avatars a
         JOIN avatar_loras l ON l.avatar_id = a.id AND l.active
        WHERE a.is_catalogue OR a.tenant_id = $1
        ORDER BY a.is_catalogue DESC, a.name ASC`,
      [tenantId]
    );
    return rows.map((a) => ({
      id: a.id, slug: a.slug, name: a.name,
      subject_type: a.subject_type, is_catalogue: a.is_catalogue,
      preview_url: a.preview_url || null,
    }));
  },

  /**
   * Create a story reel from a user's CASTING of it.
   *
   * `casting` maps each role key to a chosen avatar id (a catalogue avatar or the
   * tenant's own). Every role must be cast. Catalogue picks are auto-selected for
   * the tenant so they pass the orchestrator's gate; then the ordinary
   * multi-character createShoot runs with the lead + co-stars + scenes. StoryCast
   * (inside createShoot) still validates each avatar is usable and refuses
   * cleanly if one is not.
   */
  async applyStory({ tenantId, userId = null, templateId, casting = {}, tier = 'free', idempotencyKey = null, intent = 'cloud' }) {
    const t = await this.get(pool, tenantId, templateId);
    if (!t) throw new TemplateError('No such story', { status: 404 });
    if (!t.is_story) throw new TemplateError('That template is not a story', { status: 409, code: 'NOT_A_STORY' });
    const recipe = t.recipe || {};
    const roles = this._storyRoles(recipe);
    if (!roles.length) throw new TemplateError('This story has no roles to cast', { status: 409, code: 'NO_ROLES' });

    const cast = casting || {};
    const missing = roles.filter((r) => !Number.isInteger(Number(cast[r.key])));
    if (missing.length) {
      throw new TemplateError(
        `Cast every role first — still to cast: ${missing.map((r) => r.label || r.key).join(', ')}`,
        { status: 400, code: 'INCOMPLETE_CAST' }
      );
    }

    const ids = [...new Set(roles.map((r) => Number(cast[r.key])))];
    const { rows: catRows } = await pool.query(
      `SELECT id FROM avatars WHERE id = ANY($1::int[]) AND is_catalogue = TRUE`, [ids]
    );
    for (const c of catRows) {
      await pool.query(
        `INSERT INTO catalogue_selections (tenant_id, avatar_id, selected_by)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, avatar_id) DO NOTHING`,
        [tenantId, c.id, userId]
      );
    }

    const leadRole = roles.find((r) => r.key === 'lead') || roles[0];
    const leadAvatarId = Number(cast[leadRole.key]);
    let scenes = Array.isArray(recipe.scenes) ? recipe.scenes : null;
    if (scenes && leadRole.key !== 'lead') {
      scenes = scenes.map((sc) => ({
        ...sc,
        shots: (Array.isArray(sc.shots) ? sc.shots : []).map((sh) =>
          (sh && String(sh.character) === leadRole.key) ? { ...sh, character: 'lead' } : sh),
      }));
    }
    const others = roles.filter((r) => r !== leadRole).map((r) => ({ key: r.key, avatarId: Number(cast[r.key]) }));

    return Orchestrator.createShoot({
      tenantId, avatarId: leadAvatarId, userId,
      kind: t.kind, frameCount: t.frame_count, brief: recipe.brief || {},
      scenes, shots: Array.isArray(recipe.shots) ? recipe.shots : [], scene: recipe.scene || {},
      cast: others, tier, clipSeconds: t.clip_seconds || 5, idempotencyKey, intent,
    });
  },
};

module.exports = ContentTemplate;
