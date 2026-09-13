-- ── 027_studio_content.sql ───────────────────────────────────────────────────
-- Avatar Studio, part 2 of 4: the content graph.
--
-- project → scene → shot, with a many-to-many shot_characters join.
--
-- v1 only ever creates ONE project, ONE scene and ONE character per post. The
-- extra levels cost nothing today and are what make long-form multi-character
-- work additive later instead of a migration of live data. This is the same
-- argument as putting tenant_id on everything from the start.
--
-- Long video is ASSEMBLED, never generated: every provider caps a single
-- generation at roughly 5–10 seconds (Google Flow caps at 8). A shot is
-- therefore the unit of generation, and a scene is the unit of continuity.

-- 1. Projects -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS studio_projects (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  avatar_id      INTEGER     NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,  -- the lead; others join via shot_characters
  title          TEXT        NOT NULL DEFAULT '',
  kind           TEXT        NOT NULL DEFAULT 'post',      -- post | carousel | reel | short | longform
  slot_type      TEXT,                                     -- workout | outfit | cafe | festival | ...
  brief          JSONB       NOT NULL DEFAULT '{}'::jsonb, -- concept, hook, caption angle, trend source
  trend_source   TEXT,                                     -- own_insights | manual | calendar
  status         TEXT        NOT NULL DEFAULT 'draft',     -- draft | generating | review | approved | published | failed
  created_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_projects_tenant ON studio_projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_studio_projects_status ON studio_projects(tenant_id, status);

-- 2. Scenes — the unit of continuity ------------------------------------------
-- Every shot inherits `continuity`, so wardrobe and props are carried by data
-- rather than hoped for across independently generated clips.
CREATE TABLE IF NOT EXISTS studio_scenes (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER     NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  seq           INTEGER     NOT NULL DEFAULT 1,
  location_key  TEXT,                                       -- one of the persona's five
  time_of_day   TEXT        NOT NULL DEFAULT 'afternoon',    -- morning | midday | afternoon | golden | night
  continuity    JSONB       NOT NULL DEFAULT '{}'::jsonb,    -- {wardrobe_key, props[], weather, established[]}
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_studio_scenes_project ON studio_scenes(project_id);

-- 3. Shots — the unit of generation -------------------------------------------
-- Every column here is a PICKER selection, not free text. The assembled prompt
-- is deliberately NOT stored: store the selections and re-render when the
-- vocabulary improves, rather than archaeology on a frozen string.
CREATE TABLE IF NOT EXISTS studio_shots (
  id                   SERIAL PRIMARY KEY,
  scene_id             INTEGER     NOT NULL REFERENCES studio_scenes(id) ON DELETE CASCADE,
  seq                  INTEGER     NOT NULL DEFAULT 1,
  framing              TEXT        NOT NULL DEFAULT 'medium',    -- close | medium | full | wide
  light_direction      TEXT        NOT NULL DEFAULT 'camera_left', -- eight-point dial
  light_quality        TEXT        NOT NULL DEFAULT 'soft',      -- soft | hard
  expression_key       TEXT        NOT NULL DEFAULT 'neutral',
  expression_intensity TEXT        NOT NULL DEFAULT 'medium',    -- light | medium | strong
  wardrobe_key         TEXT,
  pose_key             TEXT,
  duration_seconds     NUMERIC(6,2),                             -- NULL for a still
  dialogue             TEXT,
  speaker_avatar_id    INTEGER     REFERENCES avatars(id) ON DELETE SET NULL,
  advanced_append      TEXT,                                     -- appends only; can never override identity
  status               TEXT        NOT NULL DEFAULT 'pending',   -- pending | generating | review | approved | rejected
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scene_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_studio_shots_scene ON studio_shots(scene_id);

-- 4. Who is in the shot -------------------------------------------------------
-- v1 writes exactly one row per shot. Two rows means a two-shot: expensive,
-- fragile (character LoRAs bleed into one another) and QC'd per character.
-- Prefer shot-reverse-shot — one face per shot — which keeps every generation
-- single-LoRA and every face independently checkable.
CREATE TABLE IF NOT EXISTS studio_shot_characters (
  shot_id     INTEGER     NOT NULL REFERENCES studio_shots(id) ON DELETE CASCADE,
  avatar_id   INTEGER     NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  lora_id     INTEGER     REFERENCES avatar_loras(id) ON DELETE SET NULL,
  role        TEXT        NOT NULL DEFAULT 'subject',    -- subject | background
  region_hint JSONB,                                     -- bbox for masked multi-LoRA routing
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (shot_id, avatar_id)
);

CREATE INDEX IF NOT EXISTS idx_shot_characters_avatar ON studio_shot_characters(avatar_id);

-- 5. Assets -------------------------------------------------------------------
-- Every generated artefact. `cost_cents` and `seconds`/`megapixels` are recorded
-- on the row rather than derived later — when the self-hosting question comes
-- back at scale, this table is what answers it with a number instead of a guess.
CREATE TABLE IF NOT EXISTS studio_assets (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      INTEGER     REFERENCES studio_projects(id) ON DELETE CASCADE,
  shot_id         INTEGER     REFERENCES studio_shots(id) ON DELETE CASCADE,
  avatar_id       INTEGER     REFERENCES avatars(id) ON DELETE SET NULL,
  lora_id         INTEGER     REFERENCES avatar_loras(id) ON DELETE SET NULL,
  kind            TEXT        NOT NULL,                    -- still | clip | reel | longform | thumbnail | audio
  storage_url     TEXT,
  prompt          TEXT,                                    -- the assembled string, kept for audit not for re-use
  workflow_json   JSONB,
  seed            BIGINT,
  provider        TEXT,                                    -- local_mac | fal | seedance | hedra | elevenlabs | e2e
  model           TEXT,
  width           INTEGER,
  height          INTEGER,
  megapixels      NUMERIC(8,3),
  seconds         NUMERIC(8,2),
  cost_cents      INTEGER     NOT NULL DEFAULT 0,
  candidate_index INTEGER     NOT NULL DEFAULT 0,          -- 0..n; free tier generates 1, paid 4
  face_similarity NUMERIC(6,4),
  qc_status       TEXT        NOT NULL DEFAULT 'pending',  -- pending | passed | rejected
  qc_reason       TEXT,                                    -- below_baseline | hands | multiple_faces | text_artifact | aspect
  selected        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_assets_tenant  ON studio_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_studio_assets_shot    ON studio_assets(shot_id);
CREATE INDEX IF NOT EXISTS idx_studio_assets_project ON studio_assets(project_id);
-- One selected asset per shot per kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_assets_selected
  ON studio_assets(shot_id, kind) WHERE selected;

-- 6. Posts — one row per channel ----------------------------------------------
-- A project publishes to Instagram AND YouTube as two rows, because the caption,
-- the format and the external id all differ.
CREATE TABLE IF NOT EXISTS studio_posts (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          INTEGER     NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  avatar_id           INTEGER     NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  channel_account_id  INTEGER,                                  -- FK added in 029, after the table exists
  platform            TEXT        NOT NULL,                     -- instagram | youtube
  media_type          TEXT        NOT NULL,                     -- image | carousel | reel | story | short | video
  media_asset_id      INTEGER     REFERENCES studio_assets(id) ON DELETE SET NULL,
  thumbnail_asset_id  INTEGER     REFERENCES studio_assets(id) ON DELETE SET NULL,
  title               TEXT,                                     -- YouTube, max 100 chars
  caption             TEXT,                                     -- IG caption / YT description (max 5000)
  hashtags            TEXT[]      NOT NULL DEFAULT '{}',
  alt_text            TEXT,
  ai_label            BOOLEAN     NOT NULL DEFAULT TRUE,        -- never default this to false
  delivery            TEXT        NOT NULL DEFAULT 'api',       -- api | assisted  (assisted = trending audio, post from phone)
  status              TEXT        NOT NULL DEFAULT 'draft',     -- draft | ready | scheduled | publishing | published | failed
  scheduled_for       TIMESTAMPTZ,
  published_at        TIMESTAMPTZ,
  external_media_id   TEXT,                                     -- ig_media_id / youtube videoId
  external_permalink  TEXT,
  failure_reason      TEXT,
  insights            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  insights_updated_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_posts_tenant    ON studio_posts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_studio_posts_project   ON studio_posts(project_id);
CREATE INDEX IF NOT EXISTS idx_studio_posts_scheduled ON studio_posts(status, scheduled_for)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_studio_posts_external  ON studio_posts(platform, external_media_id);
