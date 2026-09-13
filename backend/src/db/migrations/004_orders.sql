-- Dedicated orders table so each Razorpay order is a first-class record
-- linked directly to the user who initiated it.  Payments reference orders
-- via order_id; this replaces the loose razorpay_order_id coupling that
-- lived only on the payments row.
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL        PRIMARY KEY,
  user_id           INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id   INT           REFERENCES subscriptions(id) ON DELETE SET NULL,
  razorpay_order_id VARCHAR(100)  UNIQUE NOT NULL,
  amount            INT           NOT NULL,
  currency          VARCHAR(3)    NOT NULL DEFAULT 'USD',
  -- Razorpay order statuses: created | attempted | paid | expired
  status            VARCHAR(30)   NOT NULL DEFAULT 'created',
  receipt           VARCHAR(100),
  description       TEXT,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- Link existing and future payments back to their parent order.
-- Nullable so migrated rows (created before this migration) keep working.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS order_id INT REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_id         ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_subscription_id ON orders(subscription_id);
CREATE INDEX IF NOT EXISTS idx_orders_razorpay_id     ON orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id      ON payments(order_id);
