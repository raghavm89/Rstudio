'use strict';

const pool = require('../config/db');
const StudioUsage = require('../models/studioUsage');
const { creditPosition, LABELS } = require('../services/studio/credits');

/**
 * Plans, and where this tenant sits among them.
 *
 * ── The free tier's entitlements live under plan_id NULL ────────────────────
 * That predates the `plans` row for Free, and it is load-bearing: `limitFor`
 * resolves a tenant with no subscription to NULL, so the NULL rows are what
 * actually gets ENFORCED. Adding a second copy under the Free plan's id would
 * be two answers to one question, and enforcement would keep using the old one
 * while the pricing page showed the new one.
 *
 * So the lookup maps slug 'free' → NULL rather than duplicating the data.
 */
const FREE_SLUG = 'free';
const planIdForLookup = (plan) => (plan.slug === FREE_SLUG ? null : plan.id);

/** The subscription a tenant is actually on, or null for the free tier. */
async function currentPlanFor(tenantId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plans p ON p.id = s.plan_id
      WHERE u.tenant_id = $1
        AND s.status IN ('active', 'authenticated')
      ORDER BY s.current_end DESC NULLS LAST
      LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

// GET /api/studio/plans
async function plans(req, res) {
  const tenantId = req.user.tenant_id;

  const [{ rows: planRows }, current, summary] = await Promise.all([
    pool.query(
      `SELECT id, slug, name, description, tagline, amount, currency, interval, sort_order,
              razorpay_plan_id
         FROM plans WHERE is_active = TRUE AND slug IS NOT NULL
        ORDER BY sort_order, id`
    ),
    tenantId ? currentPlanFor(tenantId) : Promise.resolve(null),
    tenantId ? StudioUsage.summary(tenantId) : Promise.resolve({}),
  ]);

  // Entitlements for every plan in one query rather than one per card.
  const ids = planRows.map(planIdForLookup);
  const { rows: ents } = await pool.query(
    `SELECT plan_id, metric, limit_value, period, notes
       FROM studio_entitlements
      WHERE plan_id IS NULL OR plan_id = ANY($1::int[])`,
    [ids.filter((v) => v !== null)]
  );

  const byPlan = new Map();
  for (const e of ents) {
    const key = e.plan_id === null ? 'null' : String(e.plan_id);
    if (!byPlan.has(key)) byPlan.set(key, []);
    byPlan.get(key).push(e);
  }

  const currentSlug = current?.slug || FREE_SLUG;

  const out = planRows.map((p) => {
    const key = planIdForLookup(p) === null ? 'null' : String(p.id);
    const rows = byPlan.get(key) || [];
    // The plan's credit allowance IS its `credits` entitlement (migration 056) —
    // one wallet, read straight off the row, not a number typed into this file.
    const walletEnt = rows.find((r) => r.metric === 'credits' && r.period === 'month');
    const credits = walletEnt ? Number(walletEnt.limit_value) : 0;

    return {
      slug:        p.slug,
      name:        p.name,
      tagline:     p.tagline,
      description: p.description,
      // Minor units in the database, rupees on the page. Converted here so no
      // client has to know which of the two it was handed.
      price:       Math.round(Number(p.amount) / 100),
      currency:    p.currency,
      interval:    p.interval,
      credits,
      current:     p.slug === currentSlug,
      /**
       * Can this actually be bought right now?
       *
       * A plan exists in the product before it exists at Razorpay, and until
       * someone creates it there, checkout can only fail. Saying so here means
       * the card can explain itself instead of offering a button whose only
       * outcome is an error banner — which is the same mistake as a button that
       * looks like it takes money and does not.
       */
      purchasable: Number(p.amount) === 0 ? false : Boolean(p.razorpay_plan_id),
      entitlements: rows
        .filter((r) => !['credits', 'video_seconds', 'still_megapixels'].includes(r.metric))
        .map((r) => ({
          metric: r.metric,
          label:  LABELS[r.metric]?.label || r.metric,
          value:  Number(r.limit_value),
          period: r.period,
          note:   r.notes,
        })),
    };
  });

  // Top-ups are a catalogue, not a balance. Consuming purchased credits needs a
  // ledger that does not exist, so these are shown and cannot be bought — the
  // page is responsible for saying so rather than implying a checkout.
  const { rows: packs } = await pool.query(
    `SELECT slug, name, credits, amount, currency
       FROM credit_packs WHERE is_active = TRUE ORDER BY sort_order, id`
  );

  return res.json({
    plans: out,
    current: currentSlug,
    credits: creditPosition(summary),
    topups: packs.map((t) => ({
      slug:    t.slug,
      name:    t.name,
      credits: t.credits,
      price:   Math.round(Number(t.amount) / 100),
      currency: t.currency,
    })),
    // Stated once, by the side that knows it, so no page has to hardcode the
    // rate card in a sentence that then drifts from the code.
    rate: { video_seconds: 1, still_megapixels: 2 },
  });
}

module.exports = { plans, currentPlanFor };
