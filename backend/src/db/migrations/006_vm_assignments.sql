-- VM assignments: maps specific VMs to specific users.
-- Replaces the coarser pve_pool approach with per-VM granularity.

CREATE TABLE IF NOT EXISTS user_vm_assignments (
  id          SERIAL PRIMARY KEY,
  user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vm_id       VARCHAR(50)  NOT NULL,   -- e.g. "qemu/101" or "lxc/200"
  assigned_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (user_id, vm_id)
);

CREATE INDEX IF NOT EXISTS idx_vm_assignments_user_id ON user_vm_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_vm_assignments_vm_id   ON user_vm_assignments(vm_id);
