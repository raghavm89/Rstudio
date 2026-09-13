'use strict';

const pool = require('../config/db');

/**
 * StudioUsage — entitlements and metering.
 *
 * Two rules, both learned the expensive way:
 *
 * 1. RESERVE AT ENQUEUE, SETTLE AT COMPLETION. "Three videos a month" means
 *    three *successful* videos to a user, but every re-roll is a full provider
 *    bill. If quota were only counted on success, ten attempts to land three
 *    keepers would cost ten videos and charge for three. So the estimate is
 *    reserved before the job is queued and reconciled to the actual afterwards.
 *
 * 2. THE CHECK LIVES IN THE QUEUE, NOT THE UI. Every generation passes through
 *    render_jobs, so that is the only place a limit cannot be worked around.
 */

const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED';

class QuotaExceededError extends Error {
  constructor(metric, requested, remaining, limit) {
    super(`Not enough ${metric} remaining: asked for ${requested}, ${remaining} left of ${limit}`);
    this.code = QUOTA_EXCEEDED;
    this.metric = metric;
    this.requested = requested;
    this.remaining = remaining;
    this.limit = limit;
  }
}

/** Lifetime metrics share one bucket; monthly metrics get one per month. */
function periodStartSql(period) {
  return period === 'lifetime'
    ? `DATE '1970-01-01'`
    : `date_trunc('month', NOW())::date`;
}

const StudioUsage = {
  QUOTA_EXCEEDED,
  QuotaExceededError,

  /**
   * The limit that applies to this tenant for one metric.
   *
   * Resolution order: the tenant's active plan, then the free tier
   * (plan_id IS NULL). A tenant with no subscription is a free-tier tenant, and
   * the same code path serves both — which is why free and paid cannot drift
   * apart in enforcement.
   */
  async limitFor(client, tenantId, metric, period = 'month') {
    const { rows } = await client.query(
      `SELECT e.limit_value
         FROM studio_entitlements e
        WHERE e.metric = $2
          AND e.period = $3
          AND e.plan_id IS NOT DISTINCT FROM (
                SELECT s.plan_id
                  FROM subscriptions s
                  JOIN users u ON u.id = s.user_id
                 WHERE u.tenant_id = $1
                   AND s.status IN ('active', 'authenticated')
                 ORDER BY s.current_end DESC NULLS LAST
                 LIMIT 1
              )
        LIMIT 1`,
      [tenantId, metric, period]
    );
    if (rows[0]) return Number(rows[0].limit_value);

    const free = await client.query(
      `SELECT limit_value FROM studio_entitlements
        WHERE metric = $1 AND period = $2 AND plan_id IS NULL LIMIT 1`,
      [metric, period]
    );
    return free.rows[0] ? Number(free.rows[0].limit_value) : 0;
  },

  /**
   * Reserve quota. Throws QuotaExceededError if it would go over.
   *
   * The INSERT ... ON CONFLICT DO UPDATE is atomic, so two jobs enqueued at the
   * same instant cannot both slip past the limit — the second sees the first's
   * increment. Checking first and updating second would let them both through.
   */
  async reserve(client, tenantId, metric, amount, period = 'month', reference = null) {
    if (!amount || amount <= 0) return { used: 0, limit: 0, remaining: 0 };

    const limit = await this.limitFor(client, tenantId, metric, period);

    /**
     * The snapshot, and the one period it must not apply to.
     *
     * `limit_value` is frozen on the row when the period opens, so that a
     * downgrade partway through a month cannot retroactively shrink a month
     * already paid for. A new month opens a new row and takes a fresh
     * snapshot, so the freeze lasts exactly as long as it should.
     *
     * A LIFETIME metric has no new month. Its row is opened once, at
     * 1970-01-01, and never rolls over — so the same COALESCE froze the cap at
     * whatever plan the tenant happened to be on when they created their FIRST
     * avatar, permanently. A free-tier customer who made one avatar, then paid
     * ₹2,000 for Pro and its three, was still refused the second: the
     * entitlement said 3 and the snapshot said 1, and the snapshot won.
     *
     * The reasoning behind the freeze does not transfer. A lifetime cap is not
     * a budget for a period already bought; it is a statement about how many of
     * something you may HAVE on your current plan. So it is re-read every time.
     * A downgrade therefore blocks new ones without deleting the existing —
     * which is what "you may have three" should mean when you stop paying for
     * three.
     */
    const lifetime = period === 'lifetime';

    const { rows } = await client.query(
      `INSERT INTO studio_usage_counters (tenant_id, metric, period_start, used, limit_value)
       VALUES ($1, $2, ${periodStartSql(period)}, $3, $4)
       ON CONFLICT (tenant_id, metric, period_start)
       DO UPDATE SET used = studio_usage_counters.used + $3,
                     limit_value = CASE WHEN $5 THEN $4
                                        ELSE COALESCE(studio_usage_counters.limit_value, $4) END,
                     updated_at = NOW()
       RETURNING used, limit_value`,
      [tenantId, metric, amount, limit, lifetime]
    );

    const used = Number(rows[0].used);
    const effectiveLimit = Number(rows[0].limit_value ?? limit);

    if (used > effectiveLimit) {
      /**
       * Past the plan allowance. Before refusing, try the purchased balance.
       *
       * Only the part that ACTUALLY exceeds the allowance is charged to bought
       * credits — a job that straddles the line is half plan and half purchase.
       * Charging the whole job would silently double-bill the portion the plan
       * had already covered.
       *
       * In this transaction, deliberately. The counter is already incremented;
       * if the spend were a separate write, a crash between the two would leave
       * usage recorded against credits nobody deducted.
       */
      const CreditLedger = require('../services/studio/creditLedger');
      const overageUnits = Math.min(Number(amount), used - effectiveLimit);
      const overageCredits = CreditLedger.creditsFor(metric, overageUnits);

      const covered = overageCredits > 0
        && await CreditLedger.spend(client, tenantId, metric, overageCredits, reference || null);

      if (covered) {
        return {
          used,
          limit: effectiveLimit,
          remaining: 0,
          // So the caller can tell the job it was paid for out of credits rather
          // than allowance, and settle can give the right amount back.
          from_credits: overageCredits,
        };
      }

      // Roll our own increment back before throwing, so a refused request does
      // not silently consume the allowance it was refused.
      await client.query(
        `UPDATE studio_usage_counters
            SET used = used - $3, updated_at = NOW()
          WHERE tenant_id = $1 AND metric = $2 AND period_start = ${periodStartSql(period)}`,
        [tenantId, metric, amount]
      );
      throw new QuotaExceededError(metric, amount, Math.max(0, effectiveLimit - (used - amount)), effectiveLimit);
    }

    return { used, limit: effectiveLimit, remaining: effectiveLimit - used, from_credits: 0 };
  },

  /**
   * Reconcile a reservation against what the job actually consumed.
   *
   * Positive delta debits further, negative refunds. Never pushed below zero,
   * because a mis-estimate should not hand a tenant free allowance.
   */
  async settle(client, tenantId, metric, reserved, actual, period = 'month', opts = {}) {
    const delta = Number(actual) - Number(reserved);

    /**
     * Give back credits the job did not use.
     *
     * A reservation is an estimate. When the estimate was paid for out of
     * purchased credits and the job came in under it, the difference has to go
     * back — otherwise every over-estimate quietly becomes revenue, and the
     * balance drifts away from what was generated in a direction that always
     * favours us. That is the kind of drift nobody reports and everybody
     * notices.
     */
    const fromCredits = Number(opts.fromCredits || 0);
    if (fromCredits > 0 && delta < 0) {
      const CreditLedger = require('../services/studio/creditLedger');
      const back = Math.min(fromCredits, CreditLedger.creditsFor(metric, -delta));
      if (back > 0) {
        await CreditLedger.refund(client, tenantId, back, opts.reference || null,
          `unused reservation on ${metric}`);
      }
    }

    if (!delta) return null;
    const { rows } = await client.query(
      `UPDATE studio_usage_counters
          SET used = GREATEST(0, used + $3), updated_at = NOW()
        WHERE tenant_id = $1 AND metric = $2 AND period_start = ${periodStartSql(period)}
      RETURNING used, limit_value`,
      [tenantId, metric, delta]
    );
    return rows[0] || null;
  },

  async addCost(client, tenantId, metric, costCents, period = 'month') {
    if (!costCents) return;
    await client.query(
      `UPDATE studio_usage_counters
          SET cost_cents = cost_cents + $3, updated_at = NOW()
        WHERE tenant_id = $1 AND metric = $2 AND period_start = ${periodStartSql(period)}`,
      [tenantId, metric, costCents]
    );
  },

  /** What the sidebar meter shows — remaining before it is spent, not after. */
  async summary(tenantId) {
    const client = await pool.connect();
    try {
      const metrics = [
        ['credits', 'month'],
        ['publishes', 'lifetime'],
        ['avatars', 'lifetime'],
        ['faces_claimed', 'lifetime'],
      ];
      const out = {};
      for (const [metric, period] of metrics) {
        const limit = await this.limitFor(client, tenantId, metric, period);
        const { rows } = await client.query(
          `SELECT used, cost_cents FROM studio_usage_counters
            WHERE tenant_id = $1 AND metric = $2 AND period_start = ${periodStartSql(period)}`,
          [tenantId, metric]
        );
        const used = rows[0] ? Number(rows[0].used) : 0;
        out[metric] = {
          used,
          limit,
          remaining: Math.max(0, limit - used),
          period,
          cost_cents: rows[0] ? Number(rows[0].cost_cents) : 0,
        };
      }
      return out;
    } finally {
      client.release();
    }
  },
};

module.exports = StudioUsage;
