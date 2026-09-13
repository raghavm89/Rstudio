const pool = require('../config/db');

const WebhookEvent = {
  // Returns true if this is the first time we've seen this signature, false
  // if Razorpay is retrying an already-processed event.
  async claim(signature, eventType) {
    const { rowCount } = await pool.query(
      `INSERT INTO webhook_events (signature, event_type)
       VALUES ($1, $2)
       ON CONFLICT (signature) DO NOTHING`,
      [signature, eventType || null]
    );
    return rowCount === 1;
  },
};

module.exports = WebhookEvent;
