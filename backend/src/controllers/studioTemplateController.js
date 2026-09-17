'use strict';

const pool = require('../config/db');
const ContentTemplate = require('../services/studio/contentTemplate');
const FormatExtract = require('../services/studio/formatExtract');
const StudioUsage = require('../models/studioUsage');

/** Template errors carry their own status; anything else is a real error. */
function fail(res, err) {
  if (err instanceof ContentTemplate.TemplateError || err.status) {
    return res.status(err.status || 400).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  throw err;
}

// GET /api/studio/templates?category=
exports.list = async (req, res) => {
  const templates = await ContentTemplate.list(pool, req.user.tenant_id, { category: req.query.category || null });
  res.json({ templates, categories: ContentTemplate.CATEGORY_KINDS });
};

// GET /api/studio/stories — the ready-to-go story library (multi-character
// reels with the cast baked in). Each story carries whether its whole cast is
// currently in the catalogue; a "coming soon" story lists but cannot be applied.
exports.stories = async (req, res) => {
  const stories = await ContentTemplate.listStories(pool, req.user.tenant_id);
  res.json({ stories });
};

// POST /api/studio/templates/:id/apply-story — instantiate a story shoot. No
// avatar_id: the cast comes from the story. Every gate/quota lives downstream.
exports.applyStory = async (req, res) => {
  try {
    const result = await ContentTemplate.applyStory({
      tenantId: req.user.tenant_id, userId: req.user.id,
      templateId: req.params.id,
      tier: req.user.plan_id ? 'paid' : 'free',
      idempotencyKey: req.body?.idempotency_key || null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({
        error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit,
      });
    }
    return fail(res, err);
  }
};

// GET /api/studio/templates/:id
exports.get = async (req, res) => {
  const t = await ContentTemplate.get(pool, req.user.tenant_id, req.params.id);
  if (!t) return res.status(404).json({ error: 'No such template' });
  res.json({ template: t });
};

// POST /api/studio/templates   { name, category, kind, recipe, cover_url }
exports.create = async (req, res) => {
  try {
    const t = await ContentTemplate.create(pool, {
      tenantId: req.user.tenant_id, userId: req.user.id,
      name: req.body?.name, category: req.body?.category, kind: req.body?.kind,
      recipe: req.body?.recipe || {}, coverUrl: req.body?.cover_url || null,
    });
    return res.status(201).json({ template: t });
  } catch (err) { return fail(res, err); }
};

// POST /api/studio/templates/from-shoot/:id   { name, category }
exports.saveFromShoot = async (req, res) => {
  try {
    const t = await ContentTemplate.saveFromShoot(pool, {
      tenantId: req.user.tenant_id, userId: req.user.id,
      projectId: req.params.id, name: req.body?.name, category: req.body?.category,
    });
    return res.status(201).json({ template: t });
  } catch (err) { return fail(res, err); }
};

// POST /api/studio/templates/:id/apply   { avatar_id }
exports.apply = async (req, res) => {
  if (!Number.isInteger(Number(req.body?.avatar_id))) {
    return res.status(400).json({ error: 'avatar_id is required' });
  }
  try {
    const result = await ContentTemplate.apply({
      tenantId: req.user.tenant_id, userId: req.user.id,
      templateId: req.params.id, avatarId: req.body.avatar_id,
      // The session decides what the customer is paying for, never the body.
      tier: req.user.plan_id ? 'paid' : 'free',
      idempotencyKey: req.body?.idempotency_key || null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({
        error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit,
      });
    }
    return fail(res, err);
  }
};

// DELETE /api/studio/templates/:id
exports.remove = async (req, res) => {
  try { await ContentTemplate.remove(pool, req.user.tenant_id, req.params.id); return res.json({ ok: true }); }
  catch (err) { return fail(res, err); }
};

// POST /api/studio/templates/:id/publish   (admin — promote to the shared library)
exports.publish = async (req, res) => {
  try { const t = await ContentTemplate.publish(pool, req.params.id); return res.json({ template: t }); }
  catch (err) { return fail(res, err); }
};

// POST /api/studio/templates/extract — turn a described format into a reusable
// template structure (T31). Returns the template-shaped object UNSAVED; the
// client reviews it and POSTs /templates to persist. Structure only — no fetch.
exports.extract = async (req, res) => {
  try {
    const { description, kind = 'reel', clip_seconds = 5 } = req.body || {};
    const out = await FormatExtract.extract({ description, kind, clipSeconds: Number(clip_seconds) || 5 });
    return res.json({ template: out });
  } catch (err) { return fail(res, err); }
};
