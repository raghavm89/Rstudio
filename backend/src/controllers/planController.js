const { validationResult } = require('express-validator');
const razorpay = require('../services/razorpay');
const Plan = require('../models/plan');
const asyncHandler = require('../middleware/asyncHandler');
const { paginated } = require('../middleware/paginate');

const INTERVALS = ['daily', 'weekly', 'monthly', 'yearly'];

// POST /api/plans  — admin only
async function createPlan(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { name, description, amount, currency = 'USD', interval, interval_count = 1 } = req.body;

  if (!INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${INTERVALS.join(', ')}` });
  }

  // Create plan in Razorpay first
  const rzPlan = await razorpay.plans.create({
    period: interval,
    interval: interval_count,
    item: {
      name,
      amount,        // in paise
      currency,
      description: description || name,
    },
  });

  const plan = await Plan.create({
    name,
    description,
    amount,
    currency,
    interval,
    interval_count,
    razorpay_plan_id: rzPlan.id,
  });

  return res.status(201).json({ message: 'Plan created', plan });
}

// GET /api/plans  — any authenticated user
async function listPlans(req, res) {
  const onlyActive = req.user.role !== 'admin';
  const { rows, total } = await Plan.findAll({ ...req.pagination, onlyActive });
  return res.json(paginated(rows, total, req.pagination));
}

// DELETE /api/plans/:id  — admin only (soft deactivate)
async function deactivatePlan(req, res) {
  const plan = await Plan.deactivate(parseInt(req.params.id, 10));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  return res.json({ message: 'Plan deactivated', plan });
}

module.exports = {
  createPlan:     asyncHandler(createPlan),
  listPlans:      asyncHandler(listPlans),
  deactivatePlan: asyncHandler(deactivatePlan),
};
