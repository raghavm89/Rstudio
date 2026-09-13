-- Migration 013: per-VM observability assignments
-- Tracks which VMs have 24/7 VM Resource Observability enabled for a tenant.
-- Quota is enforced by the backend (assigned count ≤ obs qty purchased).

CREATE TABLE IF NOT EXISTS vm_observability_assignments (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vm_id       VARCHAR(100) NOT NULL,
  assigned_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  assigned_by INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, vm_id)
);

CREATE INDEX IF NOT EXISTS idx_vm_obs_tenant ON vm_observability_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vm_obs_vm     ON vm_observability_assignments(vm_id);
