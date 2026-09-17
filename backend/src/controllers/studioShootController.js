'use strict';

const Orchestrator = require('../services/studio/orchestrator');
const ShootPlanner = require('../services/studio/shootPlanner');
const Transcribe = require('../services/studio/transcribe');
const PlanFeedback = require('../services/studio/planFeedback');
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
const LIGHT_DIRECTION = ['camera_left', 'camera_right', 'front', 'front_left', 'front_right', 'back_left', 'back_right', 'top'];
const LIGHT_QUALITY = ['soft', 'hard'];
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
    'SELECT id, tenant_id, title, kind, status, avatar_id FROM studio_projects WHERE id = $1',
    [req.params.id]
  );
  const project = rows[0];
  // Same 404 for missing and not-yours: a different status would confirm that a
  // project id exists in another tenant.
  if (!project || project.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: 'Shoot not found' });
  }

  const progress = await Orchestrator.progress(req.user.tenant_id, req.params.id);

  // The finished media: the reel/clip first, then stills that passed QC.
  const { rows: assets } = await pool.query(
    `SELECT id, kind, shot_id, candidate_index, storage_url, qc_status, qc_reason, face_similarity,
            width, height, seconds, selected, created_at
       FROM studio_assets
      WHERE tenant_id = $1 AND project_id = $2 AND storage_url IS NOT NULL
        AND qc_status IS DISTINCT FROM 'superseded'
      ORDER BY (kind IN ('reel','longform','clip','short')) DESC, selected DESC, created_at DESC`,
    [req.user.tenant_id, req.params.id]
  );

  // Why a failed shoot failed — the first failed job's stage, label and message.
  // Surfaced so the detail page can say what went wrong instead of a bare
  // "Failed", and so a rejected frame can show its QC reason and score.
  let failure = null;
  if (progress.status === 'failed') {
    const { rows: fj } = await pool.query(
      `SELECT stage, label, error FROM render_jobs
        WHERE project_id = $1 AND status = 'failed' AND error IS NOT NULL
        ORDER BY step_index, id LIMIT 1`,
      [req.params.id]
    );
    if (fj[0]) failure = { stage: fj[0].stage, label: fj[0].label, message: fj[0].error };
  }

  res.json({ project, progress, assets, failure });
};

// GET /api/studio/shoots — the tenant's shoots, newest first.
exports.list = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.kind, p.slot_type, p.created_at,
            a.name AS avatar_name,
            CASE
              WHEN p.status = 'discarded' THEN 'discarded'
              WHEN EXISTS (SELECT 1 FROM render_jobs j WHERE j.project_id = p.id AND j.status IN ('queued','claimed','running')) THEN 'generating'
              WHEN EXISTS (SELECT 1 FROM render_jobs j WHERE j.project_id = p.id AND j.status = 'held') THEN 'review'
              WHEN EXISTS (SELECT 1 FROM render_jobs j WHERE j.project_id = p.id AND j.status = 'failed') THEN 'failed'
              WHEN EXISTS (SELECT 1 FROM render_jobs j WHERE j.project_id = p.id) THEN 'done'
              ELSE p.status
            END AS status,
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

exports.plan = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const { avatar_id, idea, kind = 'reel', clip_seconds = 5, frame_count, coverage = false, cast = null } = req.body || {};
  if (!avatar_id) return res.status(400).json({ error: 'avatar_id is required' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
  try {
    const out = await ShootPlanner.plan({
      tenantId,
      avatarId: Number(avatar_id),
      idea: String(idea || ''),
      kind,
      clipSeconds: Number(clip_seconds) || 5,
      frameCount: frame_count ? Number(frame_count) : undefined,
      tier: (req.user.role === 'admin' || req.user.plan_id) ? 'paid' : 'free',
      userId: req.user.id,
      coverage: Boolean(coverage),
      cast: Array.isArray(cast) ? cast : null,
    });
    // Capture the proposal for the self-learning loop, and thread its id so
    // generate can attach the approved (edited) plan. Best-effort: never fail a
    // plan over a logging error.
    let planId = null;
    try {
      planId = await PlanFeedback.recordProposal({
        tenantId, avatarId: Number(avatar_id), userId: req.user.id,
        idea: String(idea || ''), kind, clipSeconds: Number(clip_seconds) || 5, proposedPlan: out,
      });
    } catch (e) { console.error('[plan feedback]', e.message); }
    // A preview, not a creation: nothing was rendered and no credit spent. The
    // user reviews/edits the storyboard, then calls generate to actually build.
    return res.status(200).json({ ...out, plan_id: planId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error('[shoot plan]', err);
    return res.status(500).json({ error: 'Could not plan the shoot' });
  }
};

/**
 * Generate from an approved (and possibly edited) storyboard. This is the ONLY
 * step that renders and spends — the plan the user saw and confirmed is exactly
 * what gets built. Tier comes from the session, never the body; the orchestrator
 * clamps every vocabulary field and caps the shot count.
 */
exports.generate = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const { avatar_id, kind = 'reel', clip_seconds = 5, brief = {}, scenes, idempotency_key = null, intent = 'cloud', plan_id = null, candidates = null, cast = null } = req.body || {};
  if (!Number.isInteger(Number(avatar_id))) return res.status(400).json({ error: 'avatar_id is required' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'scenes[] is required — plan the shoot first' });
  const clipSeconds = Number(clip_seconds);
  if (!Number.isFinite(clipSeconds) || clipSeconds < 2 || clipSeconds > 10) {
    return res.status(400).json({ error: 'clip_seconds must be between 2 and 10' });
  }
  if (typeof brief !== 'object' || brief === null || Array.isArray(brief)) {
    return res.status(400).json({ error: 'brief must be an object' });
  }
  try {
    const result = await Orchestrator.createShoot({
      tenantId,
      avatarId: Number(avatar_id),
      userId: req.user.id,
      kind,
      brief,
      scenes,
      cast: Array.isArray(cast) ? cast : null,
      tier: (req.user.role === 'admin' || req.user.plan_id) ? 'paid' : 'free',
      clipSeconds,
      idempotencyKey: idempotency_key,
      intent,
      candidatesPerShot: (candidates != null && candidates !== '') ? Number(candidates) : null,
    });
    // Attach the approved (possibly edited) plan + the shoot to the feedback row.
    try {
      await PlanFeedback.recordApproval({
        id: plan_id, tenantId,
        approvedPlan: { brief, kind, clip_seconds: clipSeconds, scenes },
        projectId: result && result.project && result.project.id,
      });
    } catch (e) { console.error('[plan feedback]', e.message); }
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({ error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
};

/**
 * Choose which candidate still wins a scene, during the Gate 2 review. Marks it
 * selected (clearing the others for that shot) and re-points the shot's HELD
 * motion job at the chosen frame — so the video animates the still the human
 * picked, not only QC's automatic best. Allowed only while the motion is still
 * held (before it runs).
 */
exports.selectStill = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);
  const shotId = Number(req.body && req.body.shot_id);
  const assetId = Number(req.body && req.body.asset_id);
  if (!shotId || !assetId) return res.status(400).json({ error: 'shot_id and asset_id are required' });

  const { rows: a } = await pool.query(
    `SELECT id, storage_url FROM studio_assets
      WHERE id = $1 AND project_id = $2 AND shot_id = $3 AND tenant_id = $4 AND kind = 'still'`,
    [assetId, projectId, shotId, tenantId]
  );
  if (!a[0]) return res.status(404).json({ error: 'Still not found for this scene' });

  const { rows: m } = await pool.query(
    `SELECT id, payload, status FROM render_jobs
      WHERE project_id = $1 AND stage = 'motion' AND shot_id = $2 ORDER BY id LIMIT 1`,
    [projectId, shotId]
  );
  if (m[0] && m[0].status !== 'held') {
    return res.status(409).json({ error: 'This scene is already being animated — the still cannot be changed now.' });
  }

  await pool.query(`UPDATE studio_assets SET selected = false WHERE project_id = $1 AND shot_id = $2 AND kind = 'still'`, [projectId, shotId]);
  await pool.query(`UPDATE studio_assets SET selected = true WHERE id = $1`, [assetId]);
  if (m[0]) {
    const gen = { ...((m[0].payload && m[0].payload.generation) || {}), image_url: a[0].storage_url };
    await pool.query(
      `UPDATE render_jobs SET payload = jsonb_set(payload, '{generation}', $2::jsonb, true), updated_at = NOW() WHERE id = $1`,
      [m[0].id, JSON.stringify(gen)]
    );
  }
  return res.json({ ok: true });
};

/**
 * Reconstruct a shoot's plan (the editable storyboard) from its stored scenes
 * and shots, in the exact shape the create-page planner emits — so "Edit the
 * plan" at Gate 2 reopens THIS shoot's scenes to change, rather than a blank
 * idea box. Read-only; renders nothing and spends nothing.
 */
exports.shootPlan = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);

  const { rows: proj } = await pool.query(
    'SELECT id, title, kind, avatar_id FROM studio_projects WHERE id = $1 AND tenant_id = $2',
    [projectId, tenantId]
  );
  if (!proj[0]) return res.status(404).json({ error: 'Shoot not found' });

  const { rows: scenes } = await pool.query(
    `SELECT id, seq, location_key, time_of_day, continuity
       FROM studio_scenes WHERE project_id = $1 ORDER BY seq`,
    [projectId]
  );
  const sceneIds = scenes.map((s) => s.id);
  const { rows: shots } = sceneIds.length
    ? await pool.query(
        `SELECT scene_id, seq, framing, light_direction, light_quality,
                expression_key, expression_intensity, wardrobe_key, pose_key, duration_seconds
           FROM studio_shots WHERE scene_id = ANY($1::int[]) ORDER BY scene_id, seq`,
        [sceneIds]
      )
    : { rows: [] };

  const shotsByScene = new Map();
  for (const sh of shots) {
    if (!shotsByScene.has(sh.scene_id)) shotsByScene.set(sh.scene_id, []);
    shotsByScene.get(sh.scene_id).push({
      pose_key: sh.pose_key || '',
      framing: sh.framing || 'medium',
      expression_key: sh.expression_key || 'soft_smile',
      light_direction: sh.light_direction || undefined,
      light_quality: sh.light_quality || undefined,
      expression_intensity: sh.expression_intensity || undefined,
      wardrobe_key: sh.wardrobe_key || undefined,
    });
  }

  // One card per BEAT: the create-page editor is one shot per scene card, so a
  // shoot stored as one scene with N shots (older multi-beat era) still reopens
  // as N editable cards, each carrying its scene's shared location/wardrobe/time.
  const outScenes = [];
  for (const sc of scenes) {
    const scShots = shotsByScene.get(sc.id) || [{}];
    const cont = (sc.continuity && typeof sc.continuity === 'object') ? sc.continuity : {};
    for (const sh of scShots) {
      outScenes.push({
        time_of_day: sc.time_of_day || 'afternoon',
        location_key: sc.location_key || undefined,
        continuity: cont,
        shots: [sh],
      });
    }
  }

  const firstDur = shots.length ? Number(shots[0].duration_seconds) : 0;
  const clipSeconds = Number.isFinite(firstDur) && firstDur >= 2 ? firstDur : 5;

  // The candidate-pool size the shoot was built with, so the Stills slider
  // reopens where it was. Best-effort.
  let candidates = null;
  try {
    const { rows: pj } = await pool.query(
      `SELECT payload FROM render_jobs WHERE project_id = $1 AND stage = 'prompt' ORDER BY id DESC LIMIT 1`,
      [projectId]
    );
    const c = pj[0] && pj[0].payload && Number(pj[0].payload.candidates);
    if (Number.isFinite(c) && c > 0) candidates = c;
  } catch (_) {}

  // The LLM concept line, if the self-learning capture recorded it.
  let brief = {};
  try {
    const { rows: pf } = await pool.query(
      `SELECT approved_plan FROM plan_feedback
        WHERE project_id = $1 AND approved_plan IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [projectId]
    );
    const ap = pf[0] && pf[0].approved_plan;
    if (ap && ap.brief && typeof ap.brief === 'object') brief = ap.brief;
  } catch (_) {}

  // The allowed vocabulary, so the reopened editor offers the same full range
  // the planner used (not a frozen frontend subset). Best-effort.
  let options = null;
  try { options = await ShootPlanner.optionsForAvatar(proj[0].avatar_id); } catch (_) {}

  return res.json({
    from_shoot: projectId,
    avatar_id: proj[0].avatar_id,
    kind: proj[0].kind,
    clipSeconds,
    brief,
    scenes: outScenes,
    candidates,
    options,
  });
};

/**
 * Approve the stills and release the video (Gate 2). Flips this shoot's HELD
 * jobs (motion, voice, assemble, copy) to queued so the render continues — the
 * one step that lets the expensive, drift-prone motion run, taken only after a
 * human has seen the frames.
 */
exports.approve = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);

  const { rows: proj } = await pool.query(
    'SELECT id FROM studio_projects WHERE id = $1 AND tenant_id = $2',
    [projectId, tenantId]
  );
  if (!proj[0]) return res.status(404).json({ error: 'Shoot not found' });

  // Clear any terminal still/qc failures from earlier reshoots so approving a
  // shoot whose frames are all picked doesn't leave it reading 'failed'. These
  // jobs are terminal and nothing depends on them.
  await pool.query(
    `DELETE FROM render_jobs WHERE project_id = $1 AND tenant_id = $2 AND status = 'failed' AND stage IN ('still','qc')`,
    [projectId, tenantId]
  );

  const { rowCount } = await pool.query(
    `UPDATE render_jobs SET status = 'queued', updated_at = NOW()
      WHERE project_id = $1 AND tenant_id = $2 AND status = 'held'`,
    [projectId, tenantId]
  );
  if (!rowCount) {
    return res.status(409).json({ error: 'Nothing to approve — this shoot is not waiting for review.' });
  }
  await pool.query(
    `UPDATE studio_projects SET status = 'generating' WHERE id = $1 AND tenant_id = $2`,
    [projectId, tenantId]
  );
  // Strongest "good plan" signal for the learner: a human approved these frames.
  try { await PlanFeedback.markStillsApproved(projectId, tenantId); } catch (e) { console.error('[plan feedback]', e.message); }
  return res.json({ ok: true, released: rowCount });
};

/**
 * Re-animate: make another video take from this shoot's selected stills. New
 * motion seeds, so the take differs; reuses the frames (no re-render, no
 * re-review); reserves only motion credits. The shoot keeps its earlier takes.
 */
exports.reanimate = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);
  try {
    const result = await Orchestrator.reanimate({ tenantId, projectId, userId: req.user.id });
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({ error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
};

/**
 * Reject the stills at Gate 2 and render a fresh set to pick from. Supersedes the
 * current candidates and re-runs prompt/still/qc with new seeds; the motion jobs
 * stay held, so nothing expensive runs until the user approves the new frames.
 */
exports.regenerateStills = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);
  try {
    const result = await Orchestrator.regenerateStills({ tenantId, projectId, userId: req.user.id });
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({ error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
};

/**
 * Edit-the-plan applied to the SAME shoot: rewrite this shoot's scenes/shots to
 * the edited storyboard and reshoot its stills (motion stays held). Keeps the
 * shoot's identity — no new project — so "edit the plan" is a revision, not a
 * fork.
 */
exports.replan = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);
  const { scenes } = req.body || {};
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'scenes[] is required — reopen the plan first' });
  try {
    const result = await Orchestrator.replan({ tenantId, projectId, userId: req.user.id, scenes });
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === StudioUsage.QUOTA_EXCEEDED) {
      return res.status(402).json({ error: err.message, code: err.code, metric: err.metric, remaining: err.remaining, limit: err.limit });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
};

exports.discard = async (req, res) => {
  const tenantId = req.user.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant on this account' });
  const projectId = Number(req.params.id);
  try {
    const result = await Orchestrator.discard({ tenantId, projectId, userId: req.user.id });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
};

// The stills-per-scene ceiling for THIS session's tier — the create page reads it
// so the slider can't offer more than the tier allows (the server clamps too).
exports.limits = async (req, res) => {
  const tier = req.user.plan_id ? 'paid' : 'free';
  return res.json({ tier, candidate_max: Orchestrator.candidateMaxForTier(tier) });
};

exports.transcribe = async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: 'No tenant on this account' });
  const { audio_base64, content_type } = req.body || {};
  if (!audio_base64) return res.status(400).json({ error: 'audio_base64 is required' });
  let buf;
  try { buf = Buffer.from(String(audio_base64), 'base64'); } catch { return res.status(400).json({ error: 'audio_base64 is not valid base64' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty audio' });
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Audio too large — keep it under ~5MB (a short clip).' });
  try {
    const text = await Transcribe.transcribe(buf, content_type || 'audio/webm');
    return res.json({ text });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error('[transcribe]', err);
    return res.status(500).json({ error: 'Could not transcribe the audio' });
  }
};

exports.KINDS = KINDS;
exports.validateShots = validateShots;
