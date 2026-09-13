-- Chat sessions per tenant/user
CREATE TABLE IF NOT EXISTS agent_chat_sessions (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT 'New Chat',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Messages per session
CREATE TABLE IF NOT EXISTS agent_chat_messages (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES agent_chat_sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,   -- 'user' | 'assistant'
  content      TEXT NOT NULL,
  tokens_used  INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_tenant ON agent_chat_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_chat_messages(session_id);
