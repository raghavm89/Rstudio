const pool = require('../config/db');

const IdempotencyKey = {
  async find({ key, userId, method, path }) {
    const { rows } = await pool.query(
      `SELECT status, response FROM idempotency_keys
       WHERE user_id = $1 AND key = $2 AND method = $3 AND path = $4`,
      [userId, key, method, path]
    );
    return rows[0] || null;
  },

  async save({ key, userId, method, path, status, response }) {
    // Race-safe: if a concurrent request already cached, do nothing — both
    // requests succeed and the first cached response is what future replays see.
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, status, response)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, key, method, path) DO NOTHING`,
      [key, userId, method, path, status, response]
    );
  },
};

module.exports = IdempotencyKey;
