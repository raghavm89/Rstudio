'use strict';

const Orchestrator = require('../services/studio/orchestrator');
const StudioUsage  = require('../models/studioUsage');
const pool         = require('../config/db');

/**
 * The one click.
 *
 * `POST /api/studio/shoots` is the door onto the orchestrator service, which
 * writes the project, scene, shots and the whole job DAG in one transaction.
 * Everything interesting happens in the service; this file's job is to validate
 * what came off the wire, decide the tier from the session rather than the body,
 * and translate service errors into status codes.
 *
 * Two things the client is NOT allowed to nominate:
 *
 *   • **tier** — it decides quality and candidate count, both of which cost
 *     money. A client that could send `tier: 'paid'` would be writing its own
 *     invoice.
 *   • **tenant** — taken from the session, never the body, same as everywhere
 *     else in this codebase.
 */

const KINDS = ['post', 'carousel', 'reel', 'short', 'longform'];

const FRAMING = ['close', 'medium', 'wide', 'full'];
const LIGHT_DIRECTION = ['camera_left', 'camera_right', 'backlit', 'flat', 'window'];
const LIGHT_QUALITY = ['soft', 'hard', 'diffused'];
const INTENSITY = ['subtle', 'medium', 'strong'];

/**
 * Shots arrive as picker selections, never as prompt text.
 *
 * The vocabulary is the product — a free-text field here would give away the
 * thing that lets a fragment improve for every tenant at once. `advanced_append`
 * is the one escape hatch, and buildWorkflow sanitises and appends it so it
 * cannot displace the identity block.
 */
function validateShots(shots, frameCount) {
  if (!Array.isArray(shots)) return 'shots must be an array';
  if (shots.length > frameCount) return `shots has ${shots.length} entries but frameCount is ${frameCount}`;

  for (const [i, s] of shots.entries()) {
    if (typeof s !== 'object' || s === null) return `shots[${i}] must be an object`;
    if (s.framing && !FRAMING.includes(s.framing)) return `shots[${i}].framing must be one of ${FRAMING.join(', ')}`;
    if (s.light_direction && !LIGHT_DIRECTION.includes(s.light_direction)) {
      return `shots[${i}].light_direction must be one of ${LIGHT_DIRECTION.join(', ')}`;
    }
    if (s.light_quality && !LIGHT_QUALITY.includes(s.light_quality)) {
      return `shots[${i}].light_quality must be one of ${LIGHT_QUALITY.join(', ')}`;
    }
    if (s.expression_intensity && !INTENSITY.includes(s.expression_intensity)) {
      return `shots[${i}].expression_intensity must be one of ${INTENSITY.join(', ')}`;
    }
    if (s.advanced_append !== undefined && typeof s.advanced_append !== 'string') {
      return `shots[${i}].advanced_append must be a string`;
    }
  }
  return null;
}

// POST /api/studio/shoots
exports.create = async (req, res) => {
  const {
    avatar_id, kind = 'post', frame_count = 4,
    brief = {}, shots = [], scene = {},
    clip_seconds = 5, idempotency_key = null, intent = 'cloud',
  } = req.body;

  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });

  if (!Number.isInteger(Number(avatar_id))) {
    return res.status(400).json({ error: 'avatar_id is required' });
  }
  if (!KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
  }

  const frameCount = Number(frame_count);
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 10) {
    return res.status(400).json({ error: 'frame_count must be an integer between 1 and 10' });
  }

  const clipSeconds = Number(clip_seconds);
  if (!Number.isFinite(clipSeconds) || clipSeconds < 2 || clipSeconds > 10) {
    // Clips are generated at 5s and assembled. Anything longer is not a longer
    // generation, it is a different plan — and a 60s "clip" would silently
    // reserve twelve times the quota the caller expected.
    return res.status(400).json({ error: 'clip_seconds must be between 2 and 10 — long-form is assembled from short clips' });
  }

  const shotError = validateShots(shots, frameCount);
  if (shotError) return res.status(400).json({ error: shotError });

  if (typeof brief !== 'object' || brief === null || Array.isArray(brief)) {
    return res.status(400).json({ error: 'brief must be an object' });
  }

  try {
    const result = await Orchestrator.createShoot({
      tenantId,
      avatarId: Number(avatar_id),
      userId: req.user.id,
      kind,
      frameCount,
      brief,
      shots,
      scene,
      // Never from the body. The session decides what the customer is paying for.
      tier: req.user.plan_id ? 'paid' : 'free',
      clipSeconds,
      idempotencyKey: idempotency_key,
      intent,
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({
        error: err.message,
        code: err.code,
        metric: err.metric,
        remaining: err.remaining,
        limit: err.limit,
      });
    }
    // The orchestrator's refusals (no LoRA, no look profile, unverified consent,
    // licence-intent conflict) carry their own status. Anything without one is a
    // real error and belongs in the error handler, not swallowed as a 400.
    if (err.status) {
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    throw err;
  }
};

// GET /api/studio/shoots/:id — what the progress view polls
exports.progress = async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, tenant_id, title, kind, status FROM studio_projects WHERE id = $1',
    [req.params.id]
  );
  const project = rows[0];
  // Same 404 for missing and not-yours: a different status would confirm that a
  // project id exists in another tenant.
  if (!project || project.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: 'Shoot not found' });
  }

  const progress = await Orchestrator.progress(req.user.tenant_id, req.params.id);
  res.json({ project, progress });
};

// GET /api/studio/shoots — the tenant's shoots, newest first.
exports.list = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.kind, p.slot_type, p.status, p.created_at,
            a.name AS avatar_name,
            (SELECT COUNT(*) FROM studio_scenes sc
               JOIN studio_shots s ON s.scene_id = sc.id
              WHERE sc.project_id = p.id)::int AS shots
       FROM studio_projects p
       LEFT JOIN avatars a ON a.id = p.avatar_id
      WHERE p.tenant_id = $1
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 100`,
    [tenantId]
  );
  return res.json({ shoots: rows });
};

exports.KINDS = KINDS;
exports.validateShots = validateShots;
