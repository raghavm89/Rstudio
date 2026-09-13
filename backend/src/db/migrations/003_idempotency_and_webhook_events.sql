-- Idempotency-Key cache for mutating endpoints. Replays return the cached
-- response so a retried client never creates a duplicate Razorpay order.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              SERIAL PRIMARY KEY,
  key             VARCHAR(255)  NOT NULL,
  user_id         INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method          VARCHAR(10)   NOT NULL,
  path            VARCHAR(255)  NOT NULL,
  status          INT           NOT NULL,
  response        JSONB         NOT NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (user_id, key, method, path)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);

-- Webhook event de-duplication. Razorpay retries on non-2xx, so we hash the
-- signature (unique per event) and refuse to re-process on collision.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           SERIAL PRIMARY KEY,
  signature    VARCHAR(128)  UNIQUE NOT NULL,
  event_type   VARCHAR(100),
  processed_at TIMESTAMPTZ   DEFAULT NOW()
);
