-- 054 — Shared catalogue avatars.
--
-- The frozen offering (claude/offering-frozen-spec.md §1) sells a SHARED
-- catalogue: Free and Catalogue tiers pick one ready-made avatar from a library
-- every tenant sees, rather than building their own (Pro+).
--
-- A catalogue entry has to be generatable the instant it is picked, which means
-- it needs a trained LoRA, a look profile AND calibration baselines. Only a
-- fully-built `avatars` row has all three — `catalogue_faces` (026) never held
-- baselines, so it cannot back the QC gate. So a catalogue entry IS an avatar,
-- flagged, owned by a platform tenant, and readable across tenants for browse
-- and (once selected) generation. `catalogue_faces` / the claim-and-retire
-- columns are the older, superseded design and are left untouched.

ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS is_catalogue           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS catalogue_region       TEXT,
  ADD COLUMN IF NOT EXISTS catalogue_published_at TIMESTAMPTZ;

-- The browse query filters is_catalogue = true across ALL tenants; a partial
-- index keeps that cross-tenant scan cheap and touches nothing else.
CREATE INDEX IF NOT EXISTS idx_avatars_catalogue
  ON avatars(is_catalogue) WHERE is_catalogue;

-- Which catalogue avatar a tenant has adopted. SHARED: this is a per-tenant
-- pointer, NOT a claim — many tenants may point at the same catalogue avatar and
-- nothing is retired. It is what ties a catalogue avatar to a tenant's plan
-- avatar slot, and what the shoot path checks before letting a tenant generate
-- against an avatar it does not own.
CREATE TABLE IF NOT EXISTS catalogue_selections (
  id           SERIAL      PRIMARY KEY,
  tenant_id    INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  avatar_id    INTEGER     NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  selected_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  selected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, avatar_id)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_selections_tenant
  ON catalogue_selections(tenant_id);
