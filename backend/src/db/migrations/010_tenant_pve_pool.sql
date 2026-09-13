-- Add pve_pool to tenants so a whole tenant can be mapped to a
-- Proxmox Resource Pool.  When set, monitoring queries filter by
-- pool="<name>" rather than enumerating individual VM IDs.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pve_pool VARCHAR(100);
