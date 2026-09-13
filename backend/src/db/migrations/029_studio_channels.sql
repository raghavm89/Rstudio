-- ── 029_studio_channels.sql ──────────────────────────────────────────────────
-- Avatar Studio, part 4 of 4: connected accounts, publishing state and the
-- comment-to-DM loop.

-- 1. Connected accounts -------------------------------------------------------
-- One row per (tenant, platform, account). Tokens are stored encrypted at the
-- application layer — the column holds ciphertext, never a raw token.
--
-- Instagram: long-lived tokens expire in 60 days. Refresh on a cron well before
-- expiry or the pipeline dies silently on a Sunday.
--
-- YouTube: `videos.insert` quota is per GOOGLE CLOUD PROJECT (~100/day), not per
-- channel — Instagram's cap scales with customers, YouTube's does not. The
-- scheduler must treat project-wide upload budget as a first-class number, which
-- is why publish_budget lives here AND in the platform-level row below.
CREATE TABLE IF NOT EXISTS channel_accounts (
  id                    SERIAL PRIMARY KEY,
  tenant_id             INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  avatar_id             INTEGER     REFERENCES avatars(id) ON DELETE SET NULL,
  platform              TEXT        NOT NULL,                 -- instagram | youtube
  external_account_id   TEXT        NOT NULL,                 -- ig_user_id | youtube channelId
  handle                TEXT,
  page_id               TEXT,                                 -- linked Facebook Page (Instagram only)

  access_token_enc      TEXT,
  refresh_token_enc     TEXT,
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT[]      NOT NULL DEFAULT '{}',

  -- Instagram only: the owner must switch "Allow access to messages" ON inside
  -- the Instagram app. It is NOT part of the OAuth consent screen, so a
  -- connection can look complete and still fail. Block the wizard until true.
  messages_access       BOOLEAN     NOT NULL DEFAULT FALSE,

  publish_budget        JSONB       NOT NULL DEFAULT '{}'::jsonb, -- cached content_publishing_limit response
  budget_checked_at     TIMESTAMPTZ,
  status                TEXT        NOT NULL DEFAULT 'connected',  -- connected | expired | revoked | error
  last_error            TEXT,
  connected_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, platform, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_accounts_tenant ON channel_accounts(tenant_id);
-- Token refresh sweep.
CREATE INDEX IF NOT EXISTS idx_channel_accounts_expiry ON channel_accounts(token_expires_at)
  WHERE status = 'connected';

-- Close the loop left open in 027. Guarded so a re-run is a no-op, matching the
-- defensive style of the migrations either side of it.
DO $$ BEGIN
  ALTER TABLE studio_posts
    ADD CONSTRAINT fk_studio_posts_channel_account
    FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_studio_posts_channel ON studio_posts(channel_account_id);

-- 2. Publish attempts ---------------------------------------------------------
-- Instagram publishing is create-container → poll status_code until FINISHED →
-- publish. Publishing before FINISHED is the most common 400 on that API and the
-- error text does not say so, hence container_status is recorded explicitly.
--
-- Instagram has NO delete endpoint. If we publish something wrong, removing it
-- is manual, forever — which is the strongest argument for keeping the human
-- approval gate on longer than feels necessary.
CREATE TABLE IF NOT EXISTS publish_attempts (
  id                SERIAL PRIMARY KEY,
  post_id           INTEGER     NOT NULL REFERENCES studio_posts(id) ON DELETE CASCADE,
  attempt           INTEGER     NOT NULL DEFAULT 1,
  container_id      TEXT,                                   -- IG creation_id / YT resumable session URI
  container_status  TEXT,                                   -- IN_PROGRESS | FINISHED | ERROR
  external_media_id TEXT,
  http_status       INTEGER,
  error_code        TEXT,
  error_body        TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  UNIQUE (post_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_post ON publish_attempts(post_id);

-- 3. DM rules -----------------------------------------------------------------
-- The copy is AUTHORED by the account holder. No model sits in the send path:
-- deterministic, reviewable at app review, cannot hallucinate a price, no
-- per-message latency at 750 sends/hour. Only merge fields are dynamic.
--
-- Disclosure is still required — Meta's rule is about the INTERACTION being
-- automated, not about who wrote the words.
CREATE TABLE IF NOT EXISTS dm_rules (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id  INTEGER     NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  scope               TEXT        NOT NULL DEFAULT 'post',  -- post | global
  post_id             INTEGER     REFERENCES studio_posts(id) ON DELETE CASCADE,
  keyword             TEXT        NOT NULL,
  match_type          TEXT        NOT NULL DEFAULT 'contains', -- exact | contains | starts_with
  public_reply        TEXT,                                    -- "sent it to your DMs" — what makes the next 100 comment
  dm_body             TEXT        NOT NULL,                    -- authored, <1000 chars
  dm_body_version     INTEGER     NOT NULL DEFAULT 1,          -- a rule edited in March must explain a message sent in February
  link                TEXT,
  variant_of          INTEGER     REFERENCES dm_rules(id) ON DELETE SET NULL,  -- A/B, still human-written
  active              BOOLEAN     NOT NULL DEFAULT FALSE,      -- inactive until a test-send succeeds
  test_sent_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_rules_tenant  ON dm_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dm_rules_lookup  ON dm_rules(channel_account_id, active);

-- 4. DM events ----------------------------------------------------------------
-- ONE private reply per comment, within 7 days of the comment, at most 750/hour
-- per account. comment_id is UNIQUE because a double-send is a hard failure, not
-- a nuisance — and a viral Reel WILL exceed the rate limit, so the queue must
-- buffer and drain rather than drop.
CREATE TABLE IF NOT EXISTS dm_events (
  id                   SERIAL PRIMARY KEY,
  tenant_id            INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id              INTEGER     REFERENCES dm_rules(id) ON DELETE SET NULL,
  channel_account_id   INTEGER     NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  post_id              INTEGER     REFERENCES studio_posts(id) ON DELETE SET NULL,
  comment_id           TEXT        NOT NULL,                   -- the dedupe key
  comment_text         TEXT,
  commenter_external_id TEXT,
  commenter_username   TEXT,
  rule_version_sent    INTEGER,
  comment_created_at   TIMESTAMPTZ,                            -- the 7-day window runs from here
  public_reply_sent_at TIMESTAMPTZ,
  dm_sent_at           TIMESTAMPTZ,
  status               TEXT        NOT NULL DEFAULT 'matched', -- matched | queued | sent | expired | failed | skipped
  error_code           TEXT,
  error                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (comment_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_events_tenant ON dm_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_events_queue  ON dm_events(channel_account_id, created_at)
  WHERE status IN ('matched', 'queued');

-- 5. Contacts — the table with commercial value -------------------------------
-- Everyone who ever triggered a rule, and which post brought them in. This is
-- what lets the planner optimise for LEADS CAPTURED rather than views — the
-- thing ManyChat cannot do, because it has no idea what content it is attached
-- to.
--
-- `replied` is set when the person answers. The automation STOPS there: one
-- authored DM per matched comment and nothing after it. An inbound reply
-- notifies the account holder and deep-links to the thread; Studio never
-- composes a word of it.
CREATE TABLE IF NOT EXISTS studio_contacts (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id  INTEGER     NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_user_id    TEXT        NOT NULL,
  username            TEXT,
  source_post_id      INTEGER     REFERENCES studio_posts(id) ON DELETE SET NULL,
  source_rule_id      INTEGER     REFERENCES dm_rules(id) ON DELETE SET NULL,
  first_seen_at       TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ DEFAULT NOW(),
  trigger_count       INTEGER     NOT NULL DEFAULT 1,
  link_clicked        BOOLEAN     NOT NULL DEFAULT FALSE,
  replied             BOOLEAN     NOT NULL DEFAULT FALSE,      -- handed to a human from here
  replied_at          TIMESTAMPTZ,
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, channel_account_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_studio_contacts_tenant ON studio_contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_studio_contacts_source ON studio_contacts(source_post_id);
