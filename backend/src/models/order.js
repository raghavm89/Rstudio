const pool = require('../config/db');

const Order = {
  async create({ user_id, subscription_id, razorpay_order_id, amount, currency, receipt, description }) {
    const { rows } = await pool.query(
      `INSERT INTO orders (user_id, subscription_id, razorpay_order_id, amount, currency, receipt, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user_id, subscription_id || null, razorpay_order_id, amount, currency || 'USD', receipt || null, description || null]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT o.*,
              u.name  AS user_name, u.email,
              p.name  AS plan_name, p.interval, p.interval_count
       FROM   orders o
       JOIN   users u        ON u.id = o.user_id
       LEFT JOIN subscriptions s ON s.id = o.subscription_id
       LEFT JOIN plans p     ON p.id = s.plan_id
       WHERE  o.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async findByRazorpayId(razorpay_order_id) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE razorpay_order_id = $1',
      [razorpay_order_id]
    );
    return rows[0] || null;
  },

  async findByUser(user_id, { limit, offset }) {
    const { rows } = await pool.query(
      `SELECT o.*,
              p.name AS plan_name, p.interval, p.interval_count
       FROM   orders o
       LEFT JOIN subscriptions s ON s.id = o.subscription_id
       LEFT JOIN plans p         ON p.id = s.plan_id
       WHERE  o.user_id = $1
       ORDER  BY o.created_at DESC
       LIMIT  $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    const { rows: c } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM orders WHERE user_id = $1',
      [user_id]
    );
    return { rows, total: c[0].total };
  },

  async findAll({ limit, offset }) {
    const { rows } = await pool.query(
      `SELECT o.*,
              u.name AS user_name, u.email,
              p.name AS plan_name, p.interval, p.interval_count
       FROM   orders o
       JOIN   users u            ON u.id = o.user_id
       LEFT JOIN subscriptions s ON s.id = o.subscription_id
       LEFT JOIN plans p         ON p.id = s.plan_id
       ORDER  BY o.created_at DESC
       LIMIT  $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: c } = await pool.query('SELECT COUNT(*)::int AS total FROM orders');
    return { rows, total: c[0].total };
  },

  async updateStatus(razorpay_order_id, status) {
    const { rows } = await pool.query(
      `UPDATE orders
       SET    status = $1, updated_at = NOW()
       WHERE  razorpay_order_id = $2
       RETURNING *`,
      [status, razorpay_order_id]
    );
    return rows[0] || null;
  },
};

module.exports = Order;
