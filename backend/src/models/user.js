const pool = require('../config/db');

const ROLES = ['admin', 'tenant_admin', 'tenant_user', 'developer'];

const SAFE_FIELDS = `
  u.id, u.name, u.email, u.phone_number, u.phone_verified,
  u.address, u.role, u.tenant_id, u.pve_pool,
  u.account_type, u.business_name, u.business_website, u.business_industry, u.gstin, u.billing_address,
  u.created_at, u.updated_at,
  t.name AS tenant_name
`;

// Joins tenants for convenience (tenant_name may be NULL for system admins)
const FROM_CLAUSE = `FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id`;

const User = {
  async findByEmail(email) {
    const { rows } = await pool.query(
      `SELECT u.*, t.name AS tenant_name ${FROM_CLAUSE} WHERE u.email = $1`,
      [email]
    );
    return rows[0] || null;
  },

  async findByPhone(phone) {
    const { rows } = await pool.query(
      `SELECT u.*, t.name AS tenant_name ${FROM_CLAUSE} WHERE u.phone_number = $1`,
      [phone]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT ${SAFE_FIELDS} ${FROM_CLAUSE} WHERE u.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * @param {object} opts
   * @param {number} opts.limit
   * @param {number} opts.offset
   * @param {string} [opts.role]       - filter by role
   * @param {number} [opts.tenant_id]  - filter by tenant
   */
  async findAll({ limit, offset, role, tenant_id } = {}) {
    const conditions = [];
    const params = [];

    if (role) {
      params.push(role);
      conditions.push(`u.role = $${params.length}`);
    }
    if (tenant_id != null) {
      params.push(tenant_id);
      conditions.push(`u.tenant_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT ${SAFE_FIELDS} ${FROM_CLAUSE} ${where} ORDER BY u.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2); // exclude limit/offset
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u ${where}`,
      countParams
    );

    return { rows, total: countRows[0].total };
  },

  /**
   * @param {object} fields
   * @param {string} fields.name
   * @param {string} fields.email
   * @param {string} fields.password_hash - already bcrypt-hashed. Named for the
   *   column it lands in: it was `password`, and a parameter whose name differs
   *   from its column is how one writer ends up on the wrong one.
   * @param {string} fields.phone_number
   * @param {string} [fields.address]
   * @param {string} [fields.role]
   * @param {number} [fields.tenant_id]
   */
  async create({ name, email, password_hash, phone_number, address, role = 'tenant_user', tenant_id = null }) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone_number, address, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, phone_number, phone_verified, address, role, tenant_id, pve_pool, created_at, updated_at`,
      [name, email, password_hash, phone_number, address || null, role, tenant_id]
    );
    return rows[0];
  },

  async markPhoneVerified(id) {
    const { rows } = await pool.query(
      `UPDATE users SET phone_verified = TRUE, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, email, phone_number, phone_verified, address, role, tenant_id, pve_pool, created_at, updated_at`,
      [id]
    );
    return rows[0] || null;
  },

  async markEmailVerified(id) {
    const { rows } = await pool.query(
      `UPDATE users SET email_verified = TRUE, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, email, phone_number, phone_verified, email_verified, address, role, tenant_id, pve_pool, created_at, updated_at`,
      [id]
    );
    return rows[0] || null;
  },

  async updateRole(id, role) {
    const { rows } = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, phone_number, phone_verified, address, role, tenant_id, pve_pool, created_at, updated_at`,
      [role, id]
    );
    return rows[0] || null;
  },

  async setPool(id, pvePool) {
    const { rows } = await pool.query(
      `UPDATE users SET pve_pool = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, phone_number, phone_verified, address, role, tenant_id, pve_pool, created_at, updated_at`,
      [pvePool || null, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return rowCount > 0;
  },
};

module.exports = { User, ROLES };
