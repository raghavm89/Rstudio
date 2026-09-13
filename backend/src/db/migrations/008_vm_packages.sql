-- ── 008_vm_packages.sql ──────────────────────────────────────────────────────
-- VM resource packages (pre-configured by Rach.Dev admin)
-- and expansion requests raised by tenant admins after payment.

-- 1. VM packages catalogue
CREATE TABLE IF NOT EXISTS vm_packages (
  id           SERIAL       PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  vm_count     INT          NOT NULL CHECK (vm_count > 0),
  price_cents  INT          NOT NULL CHECK (price_cents >= 0),  -- in smallest currency unit
  currency     VARCHAR(3)   NOT NULL DEFAULT 'USD',
  billing_period VARCHAR(20) NOT NULL DEFAULT 'monthly',        -- monthly | yearly | one_time
  is_active    BOOLEAN      DEFAULT TRUE,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- 2. Expansion requests — raised after successful payment
DO $$ BEGIN
  CREATE TYPE expansion_status AS ENUM ('pending', 'fulfilled', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS vm_expansion_requests (
  id              SERIAL           PRIMARY KEY,
  tenant_id       INT              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id      INT              NOT NULL REFERENCES vm_packages(id),
  requested_by    INT              NOT NULL REFERENCES users(id),
  razorpay_order_id VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  amount_paid     INT,
  currency        VARCHAR(3),
  status          expansion_status NOT NULL DEFAULT 'pending',
  notes           TEXT,
  requested_at    TIMESTAMPTZ      DEFAULT NOW(),
  fulfilled_at    TIMESTAMPTZ,
  fulfilled_by    INT              REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_expansion_requests_tenant  ON vm_expansion_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expansion_requests_status  ON vm_expansion_requests(status);

-- 3. Seed default packages so the billing page works immediately
INSERT INTO vm_packages (name, description, vm_count, price_cents, currency, billing_period)
VALUES
  ('Single VM',      'Add 1 virtual machine to your tenant pool',      1,   2999, 'USD', 'monthly'),
  ('Starter Bundle', 'Add 3 VMs at a discounted rate',                 3,   7999, 'USD', 'monthly'),
  ('Growth Bundle',  'Add 5 VMs — best value for growing teams',       5,  11999, 'USD', 'monthly'),
  ('Scale Bundle',   'Add 10 VMs for high-demand workloads',          10,  19999, 'USD', 'monthly')
ON CONFLICT DO NOTHING;
