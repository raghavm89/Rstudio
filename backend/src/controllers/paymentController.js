const crypto = require('crypto');
const { validationResult } = require('express-validator');
const razorpay = require('../services/razorpay');
const Plan = require('../models/plan');
const Order = require('../models/order');
const Subscription = require('../models/subscription');
const Payment = require('../models/payment');
const WebhookEvent = require('../models/webhookEvent');
const asyncHandler = require('../middleware/asyncHandler');
const { paginated } = require('../middleware/paginate');

// ─── Subscriptions ────────────────────────────────────────────────────────────

// POST /api/payments/subscribe  — customer only
async function subscribe(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { plan_id, total_count = 12 } = req.body;

  const plan = await Plan.findById(plan_id);
  if (!plan || !plan.is_active) {
    return res.status(404).json({ error: 'Plan not found or inactive' });
  }

  const rzSub = await razorpay.subscriptions.create({
    plan_id: plan.razorpay_plan_id,
    total_count,
    quantity: 1,
    customer_notify: 1,
  });

  const subscription = await Subscription.create({
    user_id: req.user.id,
    plan_id: plan.id,
    razorpay_sub_id: rzSub.id,
    total_count,
  });

  return res.status(201).json({
    message: 'Subscription created. Complete checkout using the subscription_id.',
    subscription,
    razorpay_subscription_id: rzSub.id,
    razorpay_key_id: process.env.RAZORPAY_KEY_ID,
  });
}

// GET /api/payments/subscriptions  — customer sees own; admin sees all
async function listSubscriptions(req, res) {
  const { rows, total } =
    req.user.role === 'admin'
      ? await Subscription.findAll(req.pagination)
      : await Subscription.findByUser(req.user.id, req.pagination);
  return res.json(paginated(rows, total, req.pagination));
}

// GET /api/payments/subscriptions/:id
async function getSubscription(req, res) {
  const sub = await Subscription.findById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (req.user.role !== 'admin' && sub.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json(sub);
}

// POST /api/payments/subscriptions/:id/cancel  — customer (own) or admin
async function cancelSubscription(req, res) {
  const sub = await Subscription.findById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (req.user.role !== 'admin' && sub.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await razorpay.subscriptions.cancel(sub.razorpay_sub_id);
  const updated = await Subscription.updateStatus(sub.razorpay_sub_id, 'cancelled');

  return res.json({ message: 'Subscription cancelled', subscription: updated });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

// POST /api/payments/orders  — customer only
// Creates a Razorpay order and persists it; no payment record is created here
// because the payment doesn't exist until the customer completes checkout.
async function createOrder(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { amount, currency = 'USD', description } = req.body;

  const receipt = `rcpt_${req.user.id}_${Date.now()}`;
  const rzOrder = await razorpay.orders.create({ amount, currency, receipt });

  const order = await Order.create({
    user_id: req.user.id,
    razorpay_order_id: rzOrder.id,
    amount,
    currency,
    receipt,
    description,
  });

  return res.status(201).json({
    message: 'Order created. Use razorpay_order_id to open the Razorpay checkout.',
    order,
    razorpay_order_id: rzOrder.id,
    razorpay_key_id: process.env.RAZORPAY_KEY_ID,
  });
}

// GET /api/payments/orders  — customer sees own; admin sees all
async function listOrders(req, res) {
  const { rows, total } =
    req.user.role === 'admin'
      ? await Order.findAll(req.pagination)
      : await Order.findByUser(req.user.id, req.pagination);
  return res.json(paginated(rows, total, req.pagination));
}

// GET /api/payments/orders/:id
async function getOrder(req, res) {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json(order);
}

// ─── Payment verification ─────────────────────────────────────────────────────

// POST /api/payments/verify  — customer: confirm payment after checkout
async function verifyPayment(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  // Guard: already verified (e.g. browser retry without idempotency key)
  const existing = await Payment.findByPaymentId(razorpay_payment_id);
  if (existing) {
    return res.json({ message: 'Payment already verified', payment: existing });
  }

  const order = await Order.findByRazorpayId(razorpay_order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    await Order.updateStatus(razorpay_order_id, 'attempted');
    return res.status(400).json({ error: 'Payment signature verification failed' });
  }

  const rzPayment = await razorpay.payments.fetch(razorpay_payment_id);

  // Payment record is created only on successful verification so the payments
  // table contains only real, captured transactions.
  await Payment.create({
    user_id: order.user_id,
    order_id: order.id,
    subscription_id: order.subscription_id,
    razorpay_order_id,
    amount: order.amount,
    currency: order.currency,
  });
  const payment = await Payment.capture(razorpay_order_id, razorpay_payment_id, rzPayment.method);
  await Order.updateStatus(razorpay_order_id, 'paid');

  return res.json({ message: 'Payment verified and captured', payment });
}

// GET /api/payments/history  — customer sees own; admin sees all
async function paymentHistory(req, res) {
  const { rows, total } =
    req.user.role === 'admin'
      ? await Payment.findAll(req.pagination)
      : await Payment.findByUser(req.user.id, req.pagination);
  return res.json(paginated(rows, total, req.pagination));
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

// POST /api/payments/webhook  — public, called by Razorpay
async function webhook(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing webhook signature' });
  }
  if (!Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({ error: 'Malformed webhook body' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  let expectedBuf, sigBuf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    sigBuf = Buffer.from(signature, 'hex');
  } catch {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Malformed webhook body' });
  }
  const { event, payload } = req.body;

  // Razorpay retries on non-2xx — de-dupe by signature (unique per event).
  const fresh = await WebhookEvent.claim(signature, event);
  if (!fresh) {
    return res.json({ received: true, duplicate: true });
  }

  switch (event) {
    case 'subscription.activated':
    case 'subscription.authenticated': {
      const sub = payload.subscription.entity;
      await Subscription.updateStatus(sub.id, sub.status, {
        current_start: sub.current_start ? new Date(sub.current_start * 1000) : null,
        current_end:   sub.current_end   ? new Date(sub.current_end   * 1000) : null,
      });
      break;
    }

    case 'subscription.charged': {
      const sub = payload.subscription.entity;
      const pmt = payload.payment.entity;

      await Subscription.updateStatus(sub.id, 'active', {
        current_start: sub.current_start ? new Date(sub.current_start * 1000) : null,
        current_end:   sub.current_end   ? new Date(sub.current_end   * 1000) : null,
        paid_count:    sub.paid_count,
      });

      const dbSub = await Subscription.findByRazorpayId(sub.id);
      if (dbSub) {
        // Each billing cycle produces a Razorpay order — track it so the user
        // can see the full order history linked to their subscription.
        let order = await Order.findByRazorpayId(pmt.order_id);
        if (!order) {
          order = await Order.create({
            user_id:        dbSub.user_id,
            subscription_id: dbSub.id,
            razorpay_order_id: pmt.order_id,
            amount:   pmt.amount,
            currency: pmt.currency,
            description: 'Monthly subscription billing cycle',
          });
        }
        await Order.updateStatus(pmt.order_id, 'paid');

        const existingPmt = await Payment.findByOrderId(pmt.order_id);
        if (!existingPmt) {
          await Payment.create({
            user_id:          dbSub.user_id,
            order_id:         order.id,
            subscription_id:  dbSub.id,
            razorpay_order_id: pmt.order_id,
            amount:   pmt.amount,
            currency: pmt.currency,
            description: 'Monthly subscription billing cycle',
          });
        }
        await Payment.capture(pmt.order_id, pmt.id, pmt.method);
      }
      break;
    }

    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.expired': {
      const sub = payload.subscription.entity;
      await Subscription.updateStatus(sub.id, sub.status);
      break;
    }

    case 'payment.failed': {
      const pmt = payload.payment.entity;
      // Mark the parent order as attempted (payment was tried but failed).
      await Order.updateStatus(pmt.order_id, 'attempted');
      // If a payment row already exists (e.g. from a subscription cycle), mark it failed too.
      await Payment.fail(pmt.order_id);
      break;
    }

    default:
      break;
  }

  return res.json({ received: true });
}

module.exports = {
  subscribe:          asyncHandler(subscribe),
  listSubscriptions:  asyncHandler(listSubscriptions),
  getSubscription:    asyncHandler(getSubscription),
  cancelSubscription: asyncHandler(cancelSubscription),
  createOrder:        asyncHandler(createOrder),
  listOrders:         asyncHandler(listOrders),
  getOrder:           asyncHandler(getOrder),
  verifyPayment:      asyncHandler(verifyPayment),
  paymentHistory:     asyncHandler(paymentHistory),
  webhook:            asyncHandler(webhook),
};
