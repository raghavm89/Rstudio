'use strict';

const { RATES } = require('./credits');

/**
 * Purchased credits: a balance, spent only after the plan allowance is gone.
 *
 * Every function here takes a `client` rather than reaching for the pool. That
 * is not style — it is the whole safety property. A spend has to happen in the
 * same transaction as the meter increment that caused it, or a crash between
 * the two leaves a tenant either billed for work that never ran or holding work
 * nobody was billed for.
 */

/** Metric units → credits. Metrics with no rate cost nothing. */
function creditsFor(metric, units) {
  const rate = RATES[metric];
  if (!rate) return 0;
  return Number(units) * rate;
}

/** Credits → metric units, for turning a balance into "how much can you do". */
function unitsFor(metric, credits) {
  const rate = RATES[metric];
  if (!rate) return Infinity;
  return Number(credits) / rate;
}

/**
 * What this tenant has bought and not yet spent.
 *
 * `FOR UPDATE` is not taken here because callers that intend to SPEND take it
 * themselves — see `spend`. Reading without the lock is fine for display and
 * wrong for a decision, which is why the two are separate functions.
 */
async function balance(client, tenantId) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(credits), 0)::numeric AS balance FROM credit_ledger WHERE tenant_id = $1',
    [tenantId]
  );
  return Number(rows[0].balance);
}

/**
 * Spend against the purchased balance, or refuse.
 *
 * Locks the tenant's rows first. Two jobs admitted concurrently would otherwise
 * both read the same balance, both find it sufficient, and both spend it — the
 * classic double-spend, and with credits it is indistinguishable from a gift.
 *
 * Returns false rather than throwing when the balance is short: the caller is
 * already deciding whether to refuse the job, and it has a better error to throw
 * than this one does.
 */
async function spend(client, tenantId, metric, credits, reference) {
  const need = Number(credits);
  if (!(need > 0)) return true;

  await client.query(
    'SELECT id FROM credit_ledger WHERE tenant_id = $1 FOR UPDATE',
    [tenantId]
  );

  const have = await balance(client, tenantId);
  if (have < need) return false;

  await client.query(
    `INSERT INTO credit_ledger (tenant_id, kind, credits, metric, reference, note)
     VALUES ($1, 'spend', $2, $3, $4, $5)`,
    [tenantId, -need, metric, reference || null,
     `past plan allowance on ${metric}`]
  );
  return true;
}

/**
 * Give credits back.
 *
 * A reservation is taken at admission and reconciled when the job finishes; a
 * job that used less than it reserved must return the difference. Without this,
 * every over-estimate quietly becomes revenue and the meter drifts away from
 * what was actually generated.
 */
async function refund(client, tenantId, credits, reference, note) {
  const give = Number(credits);
  if (!(give > 0)) return;
  await client.query(
    `INSERT INTO credit_ledger (tenant_id, kind, credits, metric, reference, note)
     VALUES ($1, 'refund', $2, NULL, $3, $4)`,
    [tenantId, give, reference || null, note || 'unused reservation returned']
  );
}

/**
 * Credit a purchase.
 *
 * `reference` is the payment id and it is UNIQUE for purchases in the schema, so
 * a webhook delivered twice — which Razorpay explicitly allows, and does —
 * inserts once. The conflict is swallowed rather than raised: the second
 * delivery is not an error, it is the same news arriving again.
 */
async function purchase(client, tenantId, credits, reference, note) {
  const { rowCount } = await client.query(
    `INSERT INTO credit_ledger (tenant_id, kind, credits, metric, reference, note)
     VALUES ($1, 'purchase', $2, NULL, $3, $4)
     ON CONFLICT (reference) WHERE kind = 'purchase' AND reference IS NOT NULL
     DO NOTHING`,
    [tenantId, Number(credits), reference || null, note || 'credit pack']
  );
  return rowCount > 0;
}

/** Recent movements, newest first — what a billing page shows under a balance. */
async function history(client, tenantId, limit = 50) {
  const { rows } = await client.query(
    `SELECT id, kind, credits, metric, reference, note, created_at
       FROM credit_ledger WHERE tenant_id = $1
      ORDER BY id DESC LIMIT $2`,
    [tenantId, Math.min(Number(limit) || 50, 200)]
  );
  return rows.map((r) => ({ ...r, credits: Number(r.credits) }));
}

module.exports = { balance, spend, refund, purchase, history, creditsFor, unitsFor };
