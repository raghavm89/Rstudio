'use strict';

const pool = require('../../config/db');

/**
 * The self-learning capture layer.
 *
 * Records the planner's proposal, the plan the user actually approved (with
 * their edits), and the outcome (did the stills pass review). This is DATA
 * CAPTURE only — it changes no behaviour. Step 2 (retrieval-augmented planning)
 * and a per-creator style memory read from here to make the planner smarter with
 * use; until then it simply accumulates the signal.
 *
 * Every write is best-effort: a feedback failure must never break a plan or a
 * generate. Callers wrap these so a logging error is swallowed, not surfaced.
 */
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
};

module.exports = PlanFeedback;
