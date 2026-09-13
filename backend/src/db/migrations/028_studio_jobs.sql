-- ── 028_studio_jobs.sql ──────────────────────────────────────────────────────
-- Avatar Studio, part 3 of 4: the queue, metering and the audit trail.
--
-- render_jobs is the spine. One row per STAGE per unit of work, so a failure
-- resumes from the last good stage instead of restarting the shoot, and so the
-- Mac worker can go offline without losing anything.
--
-- It is also the single choke point for free-tier limits. Every generation
-- passes through here, so the cap belongs here and not in the UI where it can
-- be worked around.

-- 1. Render jobs --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS render_jobs (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id        INTEGER     REFERENCES studio_projects(id) ON DELETE CASCADE,
  shot_id           INTEGER     REFERENCES studio_shots(id) ON DELETE CASCADE,
  post_id           INTEGER     REFERENCES studio_posts(id) ON DELETE CASCADE,

  stage             TEXT        NOT NULL,   -- brief | prompt | still | qc | motion | voice | lipsync | assemble | copy | publish | insights
  runner            TEXT        NOT NULL DEFAULT 'server',  -- mac | cloud | server
  provider          TEXT,                                   -- local_mac | fal | seedance | veo | hedra | e2e | elevenlabs
  priority          INTEGER     NOT NULL DEFAULT 100,       -- lower runs first; paid work outranks free

  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result            JSONB       NOT NULL DEFAULT '{}'::jsonb,

  status            TEXT        NOT NULL DEFAULT 'queued',  -- queued | claimed | running | done | failed | cancelled
  attempts          INTEGER     NOT NULL DEFAULT 0,
  max_attempts      INTEGER     NOT NULL DEFAULT 3,
  claimed_by        TEXT,                                   -- worker identity, e.g. 'mac-raghav-01'
  claimed_at        TIMESTAMPTZ,
  lease_expires_at  TIMESTAMPTZ,                            -- a dead worker's job returns to the queue
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  error             TEXT,

  -- Metering. Recorded per job so the self-hosting question is answered by a
  -- query rather than an estimate:
  --   break-even throughput = gpu_hourly_rate / api_per_second_rate
  seconds_generated NUMERIC(10,2) NOT NULL DEFAULT 0,
  megapixels        NUMERIC(10,3) NOT NULL DEFAULT 0,
  cost_cents        INTEGER       NOT NULL DEFAULT 0,

  idempotency_key   TEXT,                                   -- a retry must never double-spend or double-post
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- The claim query: GET /api/studio/jobs/next?runner=mac
CREATE INDEX IF NOT EXISTS idx_render_jobs_claim
  ON render_jobs(runner, priority, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_render_jobs_tenant  ON render_jobs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON render_jobs(project_id);
-- Reaper: find leases that expired while a worker was away.
CREATE INDEX IF NOT EXISTS idx_render_jobs_lease
  ON render_jobs(lease_expires_at) WHERE status IN ('claimed', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS uq_render_jobs_idempotency
  ON render_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 2. Entitlements — what a plan allows ----------------------------------------
-- plan_id NULL = the free tier. Metric names are the same units the paid side
-- bills in, so free and paid are enforced by one code path.
CREATE TABLE IF NOT EXISTS studio_entitlements (
  id          SERIAL PRIMARY KEY,
  plan_id     INTEGER     REFERENCES plans(id) ON DELETE CASCADE,
  metric      TEXT        NOT NULL,       -- video_seconds | still_megapixels | publishes | avatars | faces_claimed
  limit_value NUMERIC(12,2) NOT NULL,
  period      TEXT        NOT NULL DEFAULT 'month',  -- month | lifetime
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (plan_id, metric, period)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_entitlements_free
  ON studio_entitlements(metric, period) WHERE plan_id IS NULL;

-- 3. Usage counters -----------------------------------------------------------
-- Incremented when a job is CLAIMED, not when it succeeds. "Three videos a
-- month" means three successful videos to a user, but every re-roll is a real
-- bill — so the budget is generated seconds, and the UI shows what remains
-- before it is spent rather than after.
CREATE TABLE IF NOT EXISTS studio_usage_counters (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric       TEXT        NOT NULL,
  period_start DATE        NOT NULL,
  used         NUMERIC(12,2) NOT NULL DEFAULT 0,
  limit_value  NUMERIC(12,2),                       -- snapshot of the entitlement when the period opened
  cost_cents   INTEGER     NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, metric, period_start)
);

CREATE INDEX IF NOT EXISTS idx_studio_usage_tenant ON studio_usage_counters(tenant_id, period_start DESC);

-- 4. Audit log ----------------------------------------------------------------
-- India's IT Rules 2026 amendment extends heightened expectations to the AI
-- tools that ENABLE creation, not just the platforms that host the result, and
-- asks for audit systems and detailed logging. Every generation must be
-- traceable to a tenant, a consent record and a source. Retrofitting this is
-- expensive; the table is cheap now.
CREATE TABLE IF NOT EXISTS studio_audit_log (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     REFERENCES tenants(id) ON DELETE SET NULL,
  user_id           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  action            TEXT        NOT NULL,   -- avatar.create | consent.verify | asset.generate | post.publish | dm.send | face.claim
  entity            TEXT,                   -- avatar | asset | post | dm_rule
  entity_id         INTEGER,
  avatar_id         INTEGER     REFERENCES avatars(id) ON DELETE SET NULL,
  consent_record_id INTEGER     REFERENCES consent_records(id) ON DELETE SET NULL,
  meta              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip                INET,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_audit_tenant ON studio_audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_audit_action ON studio_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_audit_avatar ON studio_audit_log(avatar_id);
