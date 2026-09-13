"use strict";

const Catalogue = require("../services/studio/catalogue");
const pool = require("../config/db");

// GET /api/studio/catalogue?region=delhi — browse the shared library.
exports.browse = async (req, res) => {
  const region = req.query.region ? String(req.query.region) : null;
  const client = await pool.connect();
  try {
    const avatars = await Catalogue.listPublished(client, { region });
    const selected = await Catalogue.selectionsFor(client, req.user.tenant_id);
    const selectedIds = new Set(selected.map((s) => s.avatar_id));
    res.json({
      catalogue: avatars.map((a) => ({ ...a, selected: selectedIds.has(a.id) })),
      selected,
    });
  } finally {
    client.release();
  }
};

// GET /api/studio/catalogue/selected — what this tenant has adopted.
exports.selected = async (req, res) => {
  const client = await pool.connect();
  try {
    res.json({ selected: await Catalogue.selectionsFor(client, req.user.tenant_id) });
  } finally {
    client.release();
  }
};

// POST /api/studio/catalogue/:id/select — adopt one for this tenant.
exports.select = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await Catalogue.select(client, {
      tenantId: req.user.tenant_id,
      userId: req.user.id,
      avatarId: Number(req.params.id),
    });
    await client.query("COMMIT");
    res.status(out.alreadyHad ? 200 : 201).json(out);
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  } finally {
    client.release();
  }
};

// POST /api/studio/avatars/:id/publish-to-catalogue — admin only.
exports.publish = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await Catalogue.publish(client, {
      avatarId: Number(req.params.id),
      region: req.body && req.body.region ? String(req.body.region) : null,
    });
    await client.query("COMMIT");
    res.json(out);
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  } finally {
    client.release();
  }
};
