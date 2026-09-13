-- 011_custom_orders.sql
-- Allow expansion requests without a package_id (custom line-item orders)

-- Make package_id nullable so custom (non-package) orders can be stored
ALTER TABLE vm_expansion_requests
  ALTER COLUMN package_id DROP NOT NULL;

-- Store a human-readable description for custom orders (e.g. "2x VM, 1x LB")
ALTER TABLE vm_expansion_requests
  ADD COLUMN IF NOT EXISTS custom_description TEXT;

-- Store the raw line items as JSON for admin visibility
ALTER TABLE vm_expansion_requests
  ADD COLUMN IF NOT EXISTS items_json JSONB;
