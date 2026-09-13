'use strict';

const pool = require('../config/db');
const asyncHandler = require('../middleware/asyncHandler');

const VMID_RE = /^(qemu|lxc)\/\d+$/;

// ─── Tenant CRUD ───────────────────────────────────────────────────────────

// GET /api/tenants
async function getAllTenants(req, res) {
  // Check whether the pve_pool column exists yet (added in migration 010).
  // This makes the endpoint safe to call both before and after that migration.
  const { rows: cols } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name='tenants' AND column_name='pve_pool'`
  );
  const hasPvePool = cols.length > 0;

  const { rows } = await pool.query(
    `SELECT t.id, t.name, ${hasPvePool ? 't.pve_pool,' : ''} t.created_at,
            COUNT(u.id)::int AS user_count,
            COUNT(tva.id)::int AS vm_count
     FROM tenants t
     LEFT JOIN users u ON u.tenant_id = t.id
     LEFT JOIN tenant_vm_assignments tva ON tva.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.id`
  );
  res.json({ tenants: rows });
}

// GET /api/tenants/:id
async function getTenantById(req, res) {
  const { id } = req.params;
  const { rows: cols } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name='tenants' AND column_name='pve_pool'`
  );
  const hasPvePool = cols.length > 0;

  const { rows } = await pool.query(
    `SELECT t.id, t.name, ${hasPvePool ? 't.pve_pool,' : ''} t.created_at, t.updated_at
     FROM tenants t WHERE t.id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

  const { rows: vms } = await pool.query(
    `SELECT vm_id, assigned_at FROM tenant_vm_assignments WHERE tenant_id = $1 ORDER BY assigned_at`,
    [id]
  );
  const { rows: users } = await pool.query(
    `SELECT id, name, email, role, created_at FROM users WHERE tenant_id = $1 ORDER BY id`,
    [id]
  );
  res.json({ tenant: rows[0], vms, users });
}

// POST /api/tenants
async function createTenant(req, res) {
  const { name, pve_pool } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const { rows: cols } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='pve_pool'`
    );
    const hasPvePool = cols.length > 0;
    const { rows } = hasPvePool
      ? await pool.query(
          `INSERT INTO tenants (name, pve_pool) VALUES ($1, $2) RETURNING *`,
          [name.trim(), pve_pool?.trim() || null]
        )
      : await pool.query(
          `INSERT INTO tenants (name) VALUES ($1) RETURNING *`,
          [name.trim()]
        );
    res.status(201).json({ message: 'Tenant created', tenant: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A tenant with that name already exists' });
    }
    throw err;
  }
}

// PATCH /api/tenants/:id
async function updateTenant(req, res) {
  const { id } = req.params;
  const { name, pve_pool } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const { rows: cols } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='pve_pool'`
    );
    const hasPvePool = cols.length > 0;
    const { rows } = hasPvePool
      ? await pool.query(
          `UPDATE tenants SET name = $1, pve_pool = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
          [name.trim(), pve_pool?.trim() || null, id]
        )
      : await pool.query(
          `UPDATE tenants SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
          [name.trim(), id]
        );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ message: 'Tenant updated', tenant: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A tenant with that name already exists' });
    }
    throw err;
  }
}

// DELETE /api/tenants/:id
async function deleteTenant(req, res) {
  const { id } = req.params;
  const { rowCount } = await pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Tenant not found' });
  res.json({ message: 'Tenant deleted' });
}

// ─── Tenant VM Pool ────────────────────────────────────────────────────────

// GET /api/tenants/:id/vms — list VMs in tenant pool
async function getTenantVMs(req, res) {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT vm_id, assigned_at FROM tenant_vm_assignments WHERE tenant_id = $1 ORDER BY assigned_at`,
    [id]
  );
  res.json({ tenantId: Number(id), vms: rows });
}

// POST /api/tenants/:id/vms — replace tenant VM pool
async function setTenantVMs(req, res) {
  const { id } = req.params;
  const { vmIds } = req.body;

  if (!Array.isArray(vmIds)) {
    return res.status(400).json({ error: 'vmIds must be an array' });
  }
  const invalid = vmIds.filter((v) => !VMID_RE.test(v));
  if (invalid.length) {
    return res.status(400).json({
      error: `Invalid VM IDs: ${invalid.join(', ')}. Expected format: qemu/<n> or lxc/<n>`,
    });
  }

  const { rows: tenantRows } = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [id]);
  if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM tenant_vm_assignments WHERE tenant_id = $1`, [id]);
    if (vmIds.length > 0) {
      const values = vmIds.map((vmId, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO tenant_vm_assignments (tenant_id, vm_id) VALUES ${values}`,
        [id, ...vmIds]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT vm_id, assigned_at FROM tenant_vm_assignments WHERE tenant_id = $1 ORDER BY assigned_at`,
    [id]
  );
  res.json({ message: 'Tenant VM pool updated', tenantId: Number(id), vms: rows });
}

module.exports = {
  getAllTenants:  asyncHandler(getAllTenants),
  getTenantById: asyncHandler(getTenantById),
  createTenant:  asyncHandler(createTenant),
  updateTenant:  asyncHandler(updateTenant),
  deleteTenant:  asyncHandler(deleteTenant),
  getTenantVMs:  asyncHandler(getTenantVMs),
  setTenantVMs:  asyncHandler(setTenantVMs),
};
