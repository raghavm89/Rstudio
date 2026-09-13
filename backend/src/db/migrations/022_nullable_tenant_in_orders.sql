-- Allow vm_expansion_requests.tenant_id to be NULL
-- Needed to support tenant_user and tenant_admin orders placed before
-- they are linked to a tenant, and for users who subscribe independently.
ALTER TABLE vm_expansion_requests ALTER COLUMN tenant_id DROP NOT NULL;
