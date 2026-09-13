const pool = require('../config/db');

const Plan = {
  async create({ name, description, amount, currency, interval, interval_count, razorpay_plan_id }) {
    const { rows } = await pool.query(
      `INSERT INTO plans (name, description, amount, currency, interval, interval_count, razorpay_plan_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, description || null, amount, currency || 'INR', interval, interval_count || 1, razorpay_plan_id]
    );
    return rows[0];
  },

  async findAll({ limit, offset, onlyActive = true } = {}) {
    const where = onlyActive ? 'WHERE is_active = TRUE' : '';
    const { rows } = await pool.query(
      `SELECT * FROM plans ${where} ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM plans ${where}`
    );
    return { rows, total: countRows[0].total };
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM plans WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async deactivate(id) {
    const { rows } = await pool.query(
      `UPDATE plans SET is_active = FALSE WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },
};

module.exports = Plan;
