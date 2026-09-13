-- ── 007_tenants.sql ──────────────────────────────────────────────────────────
-- Introduces multi-tenancy:
--   • tenants table (an organisation that subscribes to Rach.Dev)
--   • new roles: tenant_admin, tenant_user  (replaces 'customer')
--   • tenant_id column on users
--   • tenant_vm_assignments — the VM pool assigned to each tenant by Rach.Dev admin
-- The existing user_vm_assignments table is kept:
--   tenant_admin assigns specific VMs (from the tenant pool) to individual users.

-- 1. Add new values to the role ENUM (safe — ADD VALUE cannot be rolled back but
--    the IF NOT EXISTS guard makes it idempotent across re-runs).
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'tenant_admin';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'tenant_user';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(150) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- 3. Link users to a tenant (NULL = Rach.Dev system admin)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- 4. Tenant VM pool — VMs that Rach.Dev admin grants to a tenant
CREATE TABLE IF NOT EXISTS tenant_vm_assignments (
  id          SERIAL       PRIMARY KEY,
  tenant_id   INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vm_id       VARCHAR(50)  NOT NULL,
  assigned_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (tenant_id, vm_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_vm_assignments_tenant ON tenant_vm_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_vm_assignments_vm     ON tenant_vm_assignments(vm_id);
