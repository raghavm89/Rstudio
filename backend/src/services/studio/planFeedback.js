'use strict';

const pool = require('../../config/db');

/**
 * The self-learning capture layer.
 *
 * Records the planner's proposal, the plan the user actually approved (with
 * their edits), and the outcome (did the stills pass review). The WRITE side
 * captures the signal; the READ side (`retrieveExemplars`) closes the loop —
 * the planner now feeds a creator's best past approved plans back into itself as
 * taste examples, so it gets smarter with use. A per-creator style memory and
 * fine-tuning are the further steps this same data asset supports.
 *
 * Every write is best-effort: a feedback failure must never break a plan or a
 * generate. Callers wrap these so a logging error is swallowed, not surfaced.
 */
/** Trim an approved plan to the human-meaningful fields, for use as an example. */
function compactScenes(plan) {
  const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
  return scenes.slice(0, 6).map((sc) => {
    const c = (sc && sc.continuity) || {};
    const sh = (sc && sc.shots && sc.shots[0]) || {};
    const out = {
      where: String(c.location_text || '').slice(0, 160),
      wardrobe: String(c.wardrobe_text || '').slice(0, 120),
      action: String(sh.pose_key || '').slice(0, 160),
      motion: String(c.motion_text || '').slice(0, 160),
      framing: sh.framing, expression: sh.expression_key, time: sc.time_of_day,
    };
    return out;
  });
}

const PlanFeedback = {
  /** At plan time: store the proposal, return its id to thread through generate. */
  async recordProposal({ tenantId, avatarId = null, userId = null, idea = '', kind = 'reel', clipSeconds = null, proposedPlan }) {
    const { rows } = await pool.query(
      `INSERT INTO plan_feedback (tenant_id, avatar_id, created_by, idea, kind, clip_seconds, proposed_plan, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'planned') RETURNING id`,
      [tenantId, avatarId, userId, String(idea || '').slice(0, 4000), kind, clipSeconds, JSON.stringify(proposedPlan || {})]
    );
    return rows[0] ? rows[0].id : null;
  },

  /**
   * At generate: attach the approved plan + the shoot, and mark whether the user
   * edited the proposal. `edited` is computed by comparing the approved scenes to
   * what was proposed — the correction signal the learner cares about most.
   */
  async recordApproval({ id, tenantId, approvedPlan, projectId = null }) {
    if (!id) return;
    let edited = false;
    try {
      const { rows } = await pool.query('SELECT proposed_plan FROM plan_feedback WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      const proposed = rows[0] && rows[0].proposed_plan;
      edited = JSON.stringify(proposed && proposed.scenes) !== JSON.stringify(approvedPlan && approvedPlan.scenes);
    } catch (_) { /* comparison is a nicety, not a requirement */ }
    await pool.query(
      `UPDATE plan_feedback
          SET approved_plan = $3::jsonb, project_id = $4, edited = $5, status = 'generated', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId, JSON.stringify(approvedPlan || {}), projectId, edited]
    );
  },

  /** At Gate 2 approval: the stills passed review — the strongest "good plan" signal. */
  async markStillsApproved(projectId, tenantId) {
    if (!projectId) return;
    await pool.query(
      `UPDATE plan_feedback SET stills_approved = TRUE, status = 'stills_approved', updated_at = NOW()
        WHERE project_id = $1 AND tenant_id = $2`,
      [projectId, tenantId]
    );
  },

  /**
   * Step 2 — the READ side of the loop. Retrieve this creator's best past
   * APPROVED plans of this kind, as compact examples to feed the planner so it
   * learns their taste and structure with use. Ranked by the strongest signal
   * first: stills passed review (rendered and the human kept the frames), then
   * the same avatar's own history, then most recent. Best-effort: any failure
   * (no table yet, no history) returns [] and the planner runs exactly as before.
   */
  async retrieveExemplars({ tenantId, kind, avatarId = null, limit = 3 } = {}) {
    if (!tenantId || !kind) return [];
    try {
      const n = Math.max(1, Math.min(5, Number(limit) || 3));
      const { rows } = await pool.query(
        `SELECT idea, approved_plan
           FROM plan_feedback
          WHERE tenant_id = $1 AND kind = $2 AND approved_plan IS NOT NULL
          ORDER BY stills_approved DESC, (avatar_id = $3) DESC, updated_at DESC
          LIMIT $4`,
        [tenantId, kind, avatarId, n]
      );
      return rows
        .map((r) => ({ idea: String(r.idea || '').slice(0, 200), scenes: compactScenes(r.approved_plan) }))
        .filter((e) => e.scenes.length);
    } catch (_) {
      return [];
    }
  },
};

module.exports = PlanFeedback;
