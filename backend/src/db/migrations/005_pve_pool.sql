-- Add pve_pool to users so each customer can be mapped to their
-- SpaceArk PVE Resource Pool.  The pool label is used to scope every
-- Prometheus query to that tenant's VMs — it is set by an admin and
-- never accepted from user-controlled input.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pve_pool VARCHAR(100);
