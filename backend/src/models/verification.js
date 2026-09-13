const crypto = require('crypto');
const pool = require('../config/db');

function hash(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

const VerificationCode = {
  // Invalidate any previous unused codes for this user, then insert a new one
  async create(userId, code, expiresAt) {
    await pool.query(
      `UPDATE verification_codes SET used = TRUE
       WHERE user_id = $1 AND used = FALSE`,
      [userId]
    );
    const { rows } = await pool.query(
      `INSERT INTO verification_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, hash(code), expiresAt]
    );
    return rows[0];
  },

  async findValid(userId, code) {
    const { rows } = await pool.query(
      `SELECT * FROM verification_codes
       WHERE user_id = $1
         AND code_hash = $2
         AND used = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, hash(code)]
    );
    return rows[0] || null;
  },

  async markUsed(id) {
    await pool.query(
      'UPDATE verification_codes SET used = TRUE WHERE id = $1',
      [id]
    );
  },
};

module.exports = VerificationCode;
