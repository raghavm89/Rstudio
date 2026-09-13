-- ── 025_agent_definitions.sql ────────────────────────────────────────────────
-- The persisted `AgentSpec`. One row = one agent definition that is BUILT in the
-- Rstudio portal (agent-builder) and OPERATED in a tenant workspace. The runtime
-- resolves `provider` (claude | vllm | ollama) with no code change, which is what
-- lets the POC run on Claude and production run on-prem (Sarvam/IndicWhisper).
--
-- tenant_id NULL = a platform template definition (shared starting point);
-- a non-NULL tenant_id = that tenant's configured instance.

CREATE TABLE IF NOT EXISTS agent_definitions (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,                 -- 'scribe' | 'reception' | 'inventory' | ...
  name         TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT '',       -- persona / job description
  tools        JSONB   NOT NULL DEFAULT '[]'::jsonb,
  guardrails   JSONB   NOT NULL DEFAULT '{}'::jsonb,
  provider     TEXT    NOT NULL DEFAULT 'claude', -- claude | vllm | ollama
  model        TEXT,                              -- e.g. 'claude-haiku-4-5-20251001' | 'sarvam-105b'
  prompt       TEXT    NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_definitions_tenant ON agent_definitions(tenant_id);
