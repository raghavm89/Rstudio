const crypto = require('crypto');
const pool = require('../config/db');

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RefreshToken = {
  // New session — generates a new family_id
  async save(userId, plainToken, expiresAt) {
    const familyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, familyId, hash(plainToken), expiresAt]
    );
    return familyId;
  },

  // Rotation — keeps the same family_id so we can detect replay
  async rotate(userId, familyId, plainToken, expiresAt) {
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, familyId, hash(plainToken), expiresAt]
    );
  },

  // Find any matching record (revoked or not) — caller checks state.
  async findByToken(plainToken) {
    const { rows } = await pool.query(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [hash(plainToken)]
    );
    return rows[0] || null;
  },

  async revoke(plainToken) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
      [hash(plainToken)]
    );
  },

  // If a revoked token is presented, the whole family is suspect — kill it.
  async revokeFamily(familyId) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE family_id = $1`,
      [familyId]
    );
  },

  async revokeAll(userId) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
      [userId]
    );
  },
};

module.exports = RefreshToken;
