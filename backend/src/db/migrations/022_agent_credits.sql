-- Credit balance per tenant (shared across all users)
CREATE TABLE IF NOT EXISTS tenant_credits (
  tenant_id   INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  balance     INTEGER NOT NULL DEFAULT 0,  -- credits remaining
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Every credit movement (purchase or usage)
CREATE TABLE IF NOT EXISTS credit_transactions (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,              -- 'purchase' | 'usage'
  amount       INTEGER NOT NULL,           -- positive = added, negative = deducted
  description  TEXT,
  tokens_used  INTEGER,                   -- filled on usage
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant ON credit_transactions(tenant_id);
