const bcrypt = require('bcryptjs');
const { User, ROLES } = require('../models/user');
const asyncHandler = require('../middleware/asyncHandler');
const { paginated } = require('../middleware/paginate');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST, 10) || 12;

// ─── GET /api/users ────────────────────────────────────────────────────────
// admin   → all users (optionally filtered by ?role=)
// tenant_admin → users in their own tenant only
async function getAllUsers(req, res) {
  const { role } = req.query;
  const caller = req.user;

  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role filter. Must be one of: ${ROLES.join(', ')}` });
  }

  const opts = { ...req.pagination, role };

  if (caller.role === 'tenant_admin') {
    if (caller.tenant_id == null) {
      // Not linked to a tenant yet — only show themselves
      const self = await User.findById(caller.id);
      return res.json(paginated(self ? [self] : [], 1, req.pagination));
    }
    // Tenant admins can only see users in their own tenant
    opts.tenant_id = caller.tenant_id;
  }

  const { rows, total } = await User.findAll(opts);
  return res.json(paginated(rows, total, req.pagination));
}

// ─── GET /api/users/:id ────────────────────────────────────────────────────
async function getUserById(req, res) {
  const { id } = req.params;
  const caller = req.user;

  const user = await User.findById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Access rules:
  // admin        → anyone
  // tenant_admin → anyone in their tenant, or themselves
  // tenant_user  → only themselves
  if (caller.role === 'admin') {
    return res.json(user);
  }
  if (caller.role === 'tenant_admin' && user.tenant_id === caller.tenant_id) {
    return res.json(user);
  }
  if (caller.id === id) {
    return res.json(user);
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ─── POST /api/users ───────────────────────────────────────────────────────
// admin        → can create any user (incl. tenant_admin, specify tenant_id)
// tenant_admin → can create tenant_admin or tenant_user in their own tenant
async function createUser(req, res) {
  const caller = req.user;
  const { name, email, password, phone_number, address, role, tenant_id } = req.body;

  if (!name || !email || !password || !phone_number) {
    return res.status(400).json({ error: 'name, email, password, phone_number are required' });
  }

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
  }

  let effectiveTenantId = tenant_id ?? null;

  if (caller.role === 'tenant_admin') {
    // Tenant admins can only create users in their own tenant
    if (role === 'admin') {
      return res.status(403).json({ error: 'Tenant admins cannot create system admins' });
    }
    effectiveTenantId = caller.tenant_id;
  }

  const [existingEmail, existingPhone] = await Promise.all([
    User.findByEmail(email),
    User.findByPhone(phone_number),
  ]);
  if (existingEmail) return res.status(409).json({ error: 'Email already registered' });
  if (existingPhone) return res.status(409).json({ error: 'Phone number already registered' });

  const hashed = await bcrypt.hash(password, BCRYPT_COST);
  const user = await User.create({
    name, email,
    password_hash: hashed,
    phone_number,
    address,
    role,
    tenant_id: effectiveTenantId,
  });

  // Auto-verify phone + email for admin-created accounts (no OTP flow needed)
  await User.markPhoneVerified(user.id);
  await User.markEmailVerified(user.id);

  const freshUser = await User.findById(user.id);
  return res.status(201).json({ message: 'User created', user: freshUser });
}

// ─── PATCH /api/users/:id/role ─────────────────────────────────────────────
async function updateUserRole(req, res) {
  const { id } = req.params;
  const { role } = req.body;
  const caller = req.user;

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
  }

  if (caller.id === id && role !== caller.role) {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }

  const updated = await User.updateRole(id, role);
  if (!updated) return res.status(404).json({ error: 'User not found' });
  // Re-fetch with tenant join so the response always includes tenant_name
  const user = await User.findById(id);
  return res.json({ message: 'Role updated', user });
}

// ─── DELETE /api/users/:id ─────────────────────────────────────────────────
async function deleteUser(req, res) {
  const { id } = req.params;
  const caller = req.user;

  if (caller.id === id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  // Tenant admins can only delete users in their tenant
  if (caller.role === 'tenant_admin') {
    const target = await User.findById(id);
    if (!target || target.tenant_id !== caller.tenant_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const deleted = await User.delete(id);
  if (!deleted) return res.status(404).json({ error: 'User not found' });
  return res.json({ message: 'User deleted' });
}

// ─── PATCH /api/users/:id/tenant ──────────────────────────────────────────
// admin only — move a user into / out of a tenant
async function updateUserTenant(req, res) {
  const { id } = req.params;
  const { tenant_id } = req.body; // null to remove from tenant

  if (tenant_id !== null && tenant_id !== undefined) {
    if (!Number.isInteger(Number(tenant_id)) || Number(tenant_id) <= 0) {
      return res.status(400).json({ error: 'tenant_id must be a positive integer or null' });
    }
  }

  const pool = require('../config/db');
  const effectiveTenantId = tenant_id != null ? Number(tenant_id) : null;

  // Verify tenant exists when assigning
  if (effectiveTenantId !== null) {
    const { rows } = await pool.query('SELECT id FROM tenants WHERE id = $1', [effectiveTenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
  }

  const { rows } = await pool.query(
    `UPDATE users SET tenant_id = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, name, email, role, tenant_id`,
    [effectiveTenantId, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  // Backfill tenant_id on all existing orders placed by this user
  // where tenant_id was NULL (orders made before tenant assignment)
  if (effectiveTenantId !== null) {
    await pool.query(
      `UPDATE vm_expansion_requests
       SET tenant_id = $1
       WHERE requested_by = $2 AND tenant_id IS NULL`,
      [effectiveTenantId, id]
    );
  }

  const user = await User.findById(id);
  return res.json({ message: 'Tenant updated', user });
}

// ─── PATCH /api/users/:id/pool ─────────────────────────────────────────────
const POOL_RE = /^[a-zA-Z0-9_-]{1,100}$/;

async function updateUserPool(req, res) {
  const { id } = req.params;
  const { pvePool } = req.body;

  if (pvePool !== null && pvePool !== undefined) {
    if (typeof pvePool !== 'string' || !POOL_RE.test(pvePool)) {
      return res.status(400).json({
        error: 'Invalid pvePool — only alphanumeric, hyphens, and underscores (max 100 chars)',
      });
    }
  }

  const user = await User.setPool(id, pvePool ?? null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ message: 'Pool assignment updated', user });
}

// ─── PATCH /api/users/me ───────────────────────────────────────────────────
// Any authenticated user can update their own profile details.
async function updateMe(req, res) {
  const caller = req.user;
  const {
    name, phone_number,
    account_type, business_name, business_website, business_industry, gstin,
    billing_address,
  } = req.body;

  const ALLOWED_INDUSTRIES = [
    'Technology & Software', 'E-Commerce & Retail', 'Healthcare & Life Sciences',
    'Financial Services & Fintech', 'Media & Entertainment', 'Education & EdTech',
    'Manufacturing & Industrial', 'Real Estate & PropTech', 'Logistics & Supply Chain',
    'Hospitality & Travel', 'Professional Services', 'Government & Public Sector',
    'Non-Profit & NGO', 'Telecommunications', 'Energy & Utilities', 'Other',
  ];

  const pool = require('../config/db');
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(name.trim());
  }
  if (phone_number !== undefined) {
    if (phone_number) {
      const existing = await User.findByPhone(phone_number);
      if (existing && existing.id !== caller.id) {
        return res.status(409).json({ error: 'Phone number already in use' });
      }
    }
    fields.push(`phone_number = $${idx++}`);
    values.push(phone_number ? phone_number.trim() : null);
  }
  if (account_type !== undefined) {
    if (!['individual', 'business'].includes(account_type)) {
      return res.status(400).json({ error: 'account_type must be individual or business' });
    }
    fields.push(`account_type = $${idx++}`);
    values.push(account_type);
  }
  if (business_name !== undefined) {
    fields.push(`business_name = $${idx++}`);
    values.push(business_name ? business_name.trim() : null);
  }
  if (business_website !== undefined) {
    fields.push(`business_website = $${idx++}`);
    values.push(business_website ? business_website.trim() : null);
  }
  if (business_industry !== undefined) {
    if (business_industry && !ALLOWED_INDUSTRIES.includes(business_industry)) {
      return res.status(400).json({ error: 'Invalid industry value' });
    }
    fields.push(`business_industry = $${idx++}`);
    values.push(business_industry || null);
  }
  if (gstin !== undefined) {
    fields.push(`gstin = $${idx++}`);
    values.push(gstin ? gstin.trim().toUpperCase() : null);
  }
  if (billing_address !== undefined) {
    fields.push(`billing_address = $${idx++}`);
    values.push(billing_address ? JSON.stringify(billing_address) : null);
  }

  if (!fields.length) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  fields.push(`updated_at = NOW()`);
  values.push(caller.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
     RETURNING id, name, email, phone_number, role, tenant_id,
               account_type, business_name, business_website, business_industry, gstin, billing_address`,
    values
  );

  return res.json({ message: 'Profile updated', user: rows[0] });
}

// ─── POST /api/users/me/password ──────────────────────────────────────────
async function changePassword(req, res) {
  const caller = req.user;
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const pool = require('../config/db');
  // Read and write the SAME column. This function used to SELECT `password` and
  // UPDATE `password_hash`, so it could not work against either schema: one of
  // the two statements always named a column that was not there.
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [caller.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  // An OAuth account has no local password, so there is nothing to check the
  // current one against — bcrypt.compare throws on undefined, which would be a
  // 500 where the honest answer is "set one instead".
  if (!rows[0].password_hash) {
    return res.status(409).json({
      error: 'This account has no password',
      message: 'It was created with Google or GitHub sign-in. Use "Forgotten your password?" to set one.',
      code : 'NO_LOCAL_PASSWORD',
    });
  }

  const valid = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

  const hashed = await bcrypt.hash(new_password, BCRYPT_COST);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, caller.id]);

  return res.json({ message: 'Password changed successfully' });
}

module.exports = {
  getAllUsers:       asyncHandler(getAllUsers),
  getUserById:      asyncHandler(getUserById),
  createUser:       asyncHandler(createUser),
  updateUserRole:   asyncHandler(updateUserRole),
  updateUserTenant: asyncHandler(updateUserTenant),
  updateUserPool:   asyncHandler(updateUserPool),
  deleteUser:       asyncHandler(deleteUser),
  updateMe:         asyncHandler(updateMe),
  changePassword:   asyncHandler(changePassword),
};
