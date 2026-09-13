-- Store SSH connection details per VM
-- Populated by admin when ARKA provides VM access
CREATE TABLE IF NOT EXISTS vm_ssh_config (
  id          SERIAL PRIMARY KEY,
  vm_id       TEXT    NOT NULL UNIQUE,   -- matches VM id from Proxmox e.g. "qemu/201"
  tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  ip_address  TEXT    NOT NULL,
  ssh_user    TEXT    NOT NULL DEFAULT 'root',
  ssh_port    INTEGER NOT NULL DEFAULT 22,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Deploy logs per service
CREATE TABLE IF NOT EXISTS deployment_logs (
  id          SERIAL PRIMARY KEY,
  service_id  INTEGER NOT NULL REFERENCES deployment_services(id) ON DELETE CASCADE,
  triggered_by TEXT   NOT NULL DEFAULT 'webhook', -- webhook | manual
  commit_sha  TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | running | success | failed
  log_output  TEXT,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deployment_logs_service ON deployment_logs(service_id);
