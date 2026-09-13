-- GitHub App installations per tenant
CREATE TABLE IF NOT EXISTS deployment_github_installations (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id  BIGINT  NOT NULL,
  github_account   TEXT,                    -- org/user login that installed the app
  installed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  installed_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id)                        -- one installation per tenant
);

-- Deployed services (repo connected to a VM)
CREATE TABLE IF NOT EXISTS deployment_services (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vm_id            TEXT    NOT NULL,
  installation_id  BIGINT  NOT NULL,
  repo_full_name   TEXT    NOT NULL,        -- e.g. "org/repo"
  branch           TEXT    NOT NULL DEFAULT 'main',
  status           TEXT    NOT NULL DEFAULT 'connected', -- connected | deploying | deployed | failed
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployment_services_tenant ON deployment_services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deployment_services_vm     ON deployment_services(vm_id);
