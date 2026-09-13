const pool = require('../config/db');

// Razorpay subscription statuses:
// created | authenticated | active | pending | halted | cancelled | completed | expired

const Subscription = {
  async create({ user_id, plan_id, razorpay_sub_id, total_count }) {
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, razorpay_sub_id, total_count)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user_id, plan_id, razorpay_sub_id, total_count || null]
    );
    return rows[0];
  },

  async findByUser(user_id, { limit, offset }) {
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.amount, p.currency, p.interval, p.interval_count
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM subscriptions WHERE user_id = $1',
      [user_id]
    );
    return { rows, total: countRows[0].total };
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.amount, p.currency, p.interval, p.interval_count
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async findByRazorpayId(razorpay_sub_id) {
    const { rows } = await pool.query(
      'SELECT * FROM subscriptions WHERE razorpay_sub_id = $1',
      [razorpay_sub_id]
    );
    return rows[0] || null;
  },

  async findAll({ limit, offset }) {
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS plan_name, u.name AS user_name, u.email
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM subscriptions'
    );
    return { rows, total: countRows[0].total };
  },

  async updateStatus(razorpay_sub_id, status, extra = {}) {
    const { rows } = await pool.query(
      `UPDATE subscriptions
       SET status = $1,
           current_start = COALESCE($3, current_start),
           current_end   = COALESCE($4, current_end),
           paid_count    = COALESCE($5, paid_count),
           updated_at    = NOW()
       WHERE razorpay_sub_id = $2
       RETURNING *`,
      [
        status,
        razorpay_sub_id,
        extra.current_start ?? null,
        extra.current_end ?? null,
        extra.paid_count ?? null,
      ]
    );
    return rows[0] || null;
  },
};

module.exports = Subscription;
