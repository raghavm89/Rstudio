const { Router } = require('express');
const { body } = require('express-validator');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const parseId = require('../middleware/parseId');
const { paginate } = require('../middleware/paginate');
const { createPlan, listPlans, deactivatePlan } = require('../controllers/planController');

const router = Router();

router.use(authenticate);

// GET  /api/plans          — any authenticated user
router.get('/', paginate({ defaultLimit: 50, maxLimit: 200 }), listPlans);

// POST /api/plans          — admin only
router.post(
  '/',
  authorize('admin'),
  [
    body('name').trim().notEmpty().withMessage('Plan name is required'),
    body('amount').isInt({ gt: 0 }).withMessage('Amount must be a positive integer (in paise)'),
    body('interval')
      .isIn(['daily', 'weekly', 'monthly', 'yearly'])
      .withMessage('interval must be daily, weekly, monthly, or yearly'),
    body('interval_count').optional().isInt({ gt: 0 }),
    body('currency').optional().isLength({ min: 3, max: 3 }),
  ],
  createPlan
);

// DELETE /api/plans/:id    — admin only (soft deactivate)
router.delete('/:id', authorize('admin'), parseId(), deactivatePlan);

module.exports = router;
