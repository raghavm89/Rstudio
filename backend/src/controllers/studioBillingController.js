'use strict';

const pool = require('../config/db');
const crypto = require('crypto');
const razorpay = require('../services/razorpay');
const Invoices = require('../services/studio/invoices');
const CreditLedger = require('../services/studio/creditLedger');
const BillingProfile = require('../services/studio/billingProfile');

/**
 * Buying things: a plan, or a pack of credits.
 *
 * ── Nothing is granted on the client's word ─────────────────────────────────
 * Razorpay Checkout hands the browser a payment id and a signature. That
 * signature is the only thing that makes it evidence, and it is verified here
 * with the key secret before a single credit is issued. A flow that credits an
 * account because the browser said the payment succeeded is a flow where the
 * browser can say it twice.
 *
 * The webhook is the belt to this braces: the browser may close before it
 * reports back, and Razorpay will tell us anyway. Both paths converge on the
 * same function, and both are idempotent — the unique index on
 * `credit_ledger.reference` and on `invoices.payment_id` mean the second arrival
 * changes nothing.
 */

const GST_RATE = Invoices.TAX_RATE;

/** Amount actually charged: our prices are GST-exclusive. */
const withTax = (paise) => paise + Math.round(paise * (GST_RATE / 100));

/**
 * Refuse to take money we cannot invoice for.
 *
 * Every payment here ends in a GST tax invoice, and an invoice needs the
 * buyer's name, address and — the one that actually changes the arithmetic —
 * their state. Without a state, `taxFor` charges a buyer in our own state IGST
 * instead of CGST+SGST, and that is a wrong invoice: it cannot be edited, only
 * cancelled and reissued, and until then the buyer cannot claim the tax back.
 *
 * So the check is here, before the order exists at the gateway, rather than at
 * issue time when the money has already moved. Answers `true` if the caller
 * should stop — the response has already been sent.
 */
async function blockedForBilling(req, res) {
  const { rows } = await pool.query(
    `SELECT billing_name, billing_line1, billing_city, billing_state, billing_pin, billing_country
       FROM users WHERE id = $1`,
    [req.user.id]
  );
  const missing = BillingProfile.missingFrom(rows[0] || {});
  if (!missing.length) return false;

  const { status, body } = BillingProfile.refusal(missing);
  res.status(status).json(body);
  return true;
}

// ── POST /api/studio/billing/subscribe  { slug } ─────────────────────────────
async function subscribe(req, res) {
  if (await blockedForBilling(req, res)) return;

  const slug = String(req.body?.slug || '').trim();
  const { rows } = await pool.query(
    'SELECT * FROM plans WHERE slug = $1 AND is_active = TRUE', [slug]
  );
  const plan = rows[0];
  if (!plan) return res.status(404).json({ error: 'No such plan' });
  if (Number(plan.amount) === 0) {
    return res.status(400).json({ error: 'The free plan is not something you subscribe to.' });
  }

  // The guard that stops a null reaching Razorpay. `razorpay_plan_id` is
  // nullable because a plan exists in the product before it exists at the
  // gateway; sending the null produces an opaque gateway error, and the honest
  // answer is that this plan is not purchasable yet.
  if (!plan.razorpay_plan_id) {
    return res.status(503).json({
      error: 'This plan cannot be bought yet',
      message: `${plan.name} has no Razorpay plan linked. Create it in the Razorpay dashboard and set plans.razorpay_plan_id.`,
      code: 'PLAN_NOT_LINKED',
    });
  }

  const sub = await razorpay.subscriptions.create({
    plan_id: plan.razorpay_plan_id,
    total_count: 12,
    quantity: 1,
    customer_notify: 1,
    notes: { tenant_id: String(req.user.tenant_id), user_id: String(req.user.id), plan: plan.slug },
  });

  await pool.query(
    `INSERT INTO subscriptions (user_id, plan_id, razorpay_sub_id, status, total_count)
     VALUES ($1, $2, $3, 'created', 12)
     ON CONFLICT DO NOTHING`,
    [req.user.id, plan.id, sub.id]
  );

  return res.status(201).json({
    razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    subscription_id: sub.id,
    plan: { slug: plan.slug, name: plan.name, amount: Number(plan.amount) },
    // Shown at checkout so the total is never a surprise — the listed price is
    // exclusive, and a customer who expected ₹2,000 should be told why it is
    // ₹2,360 before they are asked to pay it.
    gst_rate: GST_RATE,
  });
}

// ── POST /api/studio/billing/topup  { slug } ─────────────────────────────────
async function topup(req, res) {
  if (await blockedForBilling(req, res)) return;

  const slug = String(req.body?.slug || 'topup-500').trim();
  const { rows } = await pool.query(
    'SELECT * FROM credit_packs WHERE slug = $1 AND is_active = TRUE', [slug]
  );
  const pack = rows[0];
  if (!pack) return res.status(404).json({ error: 'No such credit pack' });

  const amount = withTax(Number(pack.amount));

  const order = await razorpay.orders.create({
    amount,
    currency: pack.currency || 'INR',
    receipt: `topup-${req.user.tenant_id}-${Date.now()}`,
    notes: {
      kind: 'credit_pack',
      pack: pack.slug,
      credits: String(pack.credits),
      tenant_id: String(req.user.tenant_id),
      user_id: String(req.user.id),
    },
  });

  return res.status(201).json({
    razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    order_id: order.id,
    amount,
    currency: order.currency,
    pack: { slug: pack.slug, credits: pack.credits, price: Number(pack.amount) / 100 },
    gst_rate: GST_RATE,
  });
}

/**
 * Verify a Razorpay signature.
 *
 * HMAC-SHA256 of `order_id|payment_id` under the key secret. `timingSafeEqual`
 * rather than `===` — a string compare leaks how much of the signature was
 * right, one byte at a time, which is enough to forge one given patience.
 */
function signatureValid({ order_id, payment_id, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${order_id}|${payment_id}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── POST /api/studio/billing/verify ──────────────────────────────────────────
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }
async function verify(req, res) {
  const order_id   = req.body?.razorpay_order_id;
  const payment_id = req.body?.razorpay_payment_id;
  const signature  = req.body?.razorpay_signature;

  if (!order_id || !payment_id || !signature) {
    return res.status(400).json({ error: 'order id, payment id and signature are all required' });
  }
  if (!signatureValid({ order_id, payment_id, signature })) {
    // Deliberately terse. A forged signature gets no detail about why it failed.
    return res.status(400).json({ error: 'Payment could not be verified', code: 'BAD_SIGNATURE' });
  }

  const order = await razorpay.orders.fetch(order_id);
  const credits = Number(order?.notes?.credits || 0);
  if (!credits) {
    return res.status(400).json({ error: 'That payment was not for credits' });
  }
  // The order's own notes decide who is credited, not the caller. A request
  // body naming a tenant would let anyone credit anyone.
  if (String(order.notes.tenant_id) !== String(req.user.tenant_id)) {
    return res.status(403).json({ error: 'That payment belongs to another workspace' });
  }

  // One extra call, for the two facts that make an invoice reconcilable: what
  // the gateway calls this payment, and how it was paid. Both go on the invoice,
  // and neither can be recovered later if the payment row is ever cleaned up.
  let method = null;
  try {
    const paid = await razorpay.payments.fetch(payment_id);
    method = paid?.method || null;
  } catch {
    // Not worth failing a verified payment over. The invoice simply omits the
    // method rather than the whole purchase being refused.
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await grantCredits(client, {
      tenantId: req.user.tenant_id,
      userId: req.user.id,
      credits,
      paymentId: payment_id,
      method,
      amountPaise: Number(order.amount_paid ?? order.amount),
      description: `${credits} credits`,
    });
    await client.query('COMMIT');
    return res.json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record the payment, credit the ledger, raise the invoice — in one transaction.
 *
 * All three or none. A payment row without its credits is money taken for
 * nothing; credits without an invoice is a customer who cannot claim the tax.
 */
async function grantCredits(client, { tenantId, userId, credits, paymentId, method, amountPaise, description }) {
  const { rows: payRows } = await client.query(
    `INSERT INTO payments (user_id, razorpay_payment_id, amount, currency, status, method, description)
     VALUES ($1, $2, $3, 'INR', 'captured', $4, $5)
     ON CONFLICT (razorpay_payment_id) DO UPDATE
       SET status = 'captured',
           -- A second delivery may know the method when the first did not.
           method = COALESCE(payments.method, EXCLUDED.method)
     RETURNING *`,
    [userId, paymentId, amountPaise, method || null, description]
  );
  const payment = payRows[0];

  const granted = await CreditLedger.purchase(client, tenantId, credits, paymentId, description);

  const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
  // The invoice is raised on the amount NET of tax, because the charge already
  // included it: the pack is priced exclusive and `withTax` added GST at order
  // time. Invoicing the gross would tax the tax.
  const net = Math.round(Number(amountPaise) / (1 + GST_RATE / 100));
  const invoice = await Invoices.issueForPayment(client, {
    payment: { ...payment, amount: net },
    user: userRows[0],
    description,
  });

  return {
    credited: granted,
    balance: await CreditLedger.balance(client, tenantId),
    invoice: Invoices.present(invoice),
  };
}

// ── GET /api/studio/invoices ─────────────────────────────────────────────────
async function listInvoices(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM studio_invoices WHERE tenant_id = $1 ORDER BY issued_at DESC, id DESC LIMIT 100`,
    [req.user.tenant_id]
  );
  return res.json({ invoices: rows.map(Invoices.present), seller: Invoices.SELLER });
}

// ── GET /api/studio/invoices/:id ─────────────────────────────────────────────
async function getInvoice(req, res) {
  const { rows } = await pool.query(
    'SELECT * FROM studio_invoices WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No such invoice' });
  return res.json(Invoices.present(rows[0]));
}

// ── GET /api/studio/billing/credits ──────────────────────────────────────────
async function creditBalance(req, res) {
  const client = await pool.connect();
  try {
    return res.json({
      balance: await CreditLedger.balance(client, req.user.tenant_id),
      history: await CreditLedger.history(client, req.user.tenant_id, 25),
    });
  } finally {
    client.release();
  }
}

module.exports = {
  subscribe, topup, verify, listInvoices, getInvoice, creditBalance,
  grantCredits, signatureValid, withTax,
};
