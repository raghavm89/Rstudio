const { Router } = require('express');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const parseId = require('../middleware/parseId');
const {
  getAllTenants,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
  getTenantVMs,
  setTenantVMs,
} = require('../controllers/tenantController');

const router = Router();

// All routes require a valid JWT and system-admin role
router.use(authenticate, authorize('admin'));

router.get('/',              getAllTenants);
router.post('/',             createTenant);
router.get('/:id',    parseId(), getTenantById);
router.patch('/:id',  parseId(), updateTenant);
router.delete('/:id', parseId(), deleteTenant);

// VM pool management
router.get('/:id/vms',  parseId(), getTenantVMs);
router.post('/:id/vms', parseId(), setTenantVMs);

module.exports = router;
