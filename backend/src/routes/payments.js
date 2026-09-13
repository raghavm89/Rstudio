const { Router } = require('express');
const { body } = require('express-validator');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const parseId = require('../middleware/parseId');
const { paginate } = require('../middleware/paginate');
const idempotency = require('../middleware/idempotency');
const {
  subscribe,
  listSubscriptions,
  getSubscription,
  cancelSubscription,
  createOrder,
  listOrders,
  getOrder,
  verifyPayment,
  paymentHistory,
  webhook,
} = require('../controllers/paymentController');

const router = Router();

// ── Webhook (no auth — Razorpay calls this directly) ─────────────────────────
router.post('/webhook', webhook);

// ── All routes below require JWT ──────────────────────────────────────────────
router.use(authenticate);

// Subscriptions (billing cycle) — customer or admin
router.post(
  '/subscribe',
  authorize('customer', 'admin'),
  idempotency(),
  [
    body('plan_id').isInt({ gt: 0 }).withMessage('Valid plan_id is required'),
    body('total_count').optional().isInt({ gt: 0 }),
  ],
  subscribe
);

router.get('/subscriptions', paginate(), listSubscriptions);             // customer=own, admin=all
router.get('/subscriptions/:id', parseId(), getSubscription);
router.post('/subscriptions/:id/cancel', parseId(), cancelSubscription); // customer=own, admin=any

// One-time orders — customer or admin
router.post(
  '/orders',
  authorize('customer', 'admin'),
  idempotency(),
  [
    body('amount').isInt({ gt: 0 }).withMessage('Amount must be a positive integer (in paise)'),
    body('currency').optional().isLength({ min: 3, max: 3 }),
    body('description').optional().trim(),
  ],
  createOrder
);

router.get('/orders',     paginate(), listOrders);              // customer=own, admin=all
router.get('/orders/:id', parseId(),  getOrder);

router.post(
  '/verify',
  authorize('customer', 'admin'),
  idempotency(),
  [
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty(),
  ],
  verifyPayment
);

// Payment history
router.get('/history', paginate(), paymentHistory);                      // customer=own, admin=all

module.exports = router;
