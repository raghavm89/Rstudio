const { Router } = require('express');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const parseId = require('../middleware/parseId');
const { paginate } = require('../middleware/paginate');
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUserRole,
  updateUserTenant,
  updateUserPool,
  deleteUser,
  updateMe,
  changePassword,
} = require('../controllers/userController');
const router = Router();

// All routes require a valid JWT
router.use(authenticate);

// ── Self-service profile routes (must come before /:id to avoid conflict) ────
router.patch('/me',          updateMe);
router.post('/me/password',  changePassword);

// GET /api/users
//   admin        → all users (optional ?role= filter)
//   tenant_admin → users in their tenant
router.get('/', authorize('admin', 'tenant_admin'), paginate(), getAllUsers);

// POST /api/users — create a user without OTP flow
//   admin        → any user in any tenant
//   tenant_admin → tenant_admin or tenant_user in their tenant
router.post('/', authorize('admin', 'tenant_admin'), createUser);

// GET /api/users/:id — admin, tenant_admin (own tenant), or self
router.get('/:id', parseId(), getUserById);

// PATCH /api/users/:id/role   — admin only
router.patch('/:id/role',   authorize('admin'), parseId(), updateUserRole);

// PATCH /api/users/:id/tenant — admin only
router.patch('/:id/tenant', authorize('admin'), parseId(), updateUserTenant);

// DELETE /api/users/:id
//   admin        → anyone
//   tenant_admin → users in their tenant (enforced in controller)
router.delete('/:id', authorize('admin', 'tenant_admin'), parseId(), deleteUser);

module.exports = router;
