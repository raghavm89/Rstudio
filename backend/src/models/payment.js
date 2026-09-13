const pool = require('../config/db');

const Payment = {
  async create({ user_id, order_id, subscription_id, razorpay_order_id, amount, currency, description }) {
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, order_id, subscription_id, razorpay_order_id, amount, currency, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user_id, order_id || null, subscription_id || null, razorpay_order_id, amount, currency || 'USD', description || null]
    );
    return rows[0];
  },

  async capture(razorpay_order_id, razorpay_payment_id, method) {
    const { rows } = await pool.query(
      `UPDATE payments
       SET razorpay_payment_id = $2, status = 'captured', method = $3
       WHERE razorpay_order_id = $1
       RETURNING *`,
      [razorpay_order_id, razorpay_payment_id, method || null]
    );
    return rows[0] || null;
  },

  async fail(razorpay_order_id) {
    await pool.query(
      `UPDATE payments SET status = 'failed' WHERE razorpay_order_id = $1`,
      [razorpay_order_id]
    );
  },

  async findByUser(user_id, { limit, offset }) {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM payments WHERE user_id = $1',
      [user_id]
    );
    return { rows, total: countRows[0].total };
  },

  async findByOrderId(razorpay_order_id) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE razorpay_order_id = $1',
      [razorpay_order_id]
    );
    return rows[0] || null;
  },

  async findByPaymentId(razorpay_payment_id) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE razorpay_payment_id = $1',
      [razorpay_payment_id]
    );
    return rows[0] || null;
  },

  async findAll({ limit, offset }) {
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS user_name, u.email
       FROM payments p
       JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM payments'
    );
    return { rows, total: countRows[0].total };
  },
};

module.exports = Payment;
