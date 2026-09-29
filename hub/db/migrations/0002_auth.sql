-- 0002_auth.sql — authentication + authorization (task 008)
--
-- Design notes:
-- * Agent identities live in `agent_identities` (separate from the `agents`
--   projection table, which tracks live agent status derived from events).
-- * Bearer tokens are `token_id.secret`. Only token_id, agent_id, and the
--   SHA-256 of the secret are stored — the plaintext secret is shown once
--   at issuance and never persisted. Rotation = issue new, then revoke old.
-- * David authenticates via GitHub OAuth. Sessions are random 256-bit ids;
--   only the SHA-256 hash is stored. Allowlist is by NUMERIC GitHub user id
--   (env DAVID_GITHUB_ID), never username.
-- * OAuth `state` values are single-use, short-lived, hashed at rest.
-- * No foreign keys, INTEGER unix-ms timestamps — same conventions as 0001.
-- * All OAuth/signing secrets live in Worker secret storage, never here.

CREATE TABLE IF NOT EXISTS agent_identities (
  agent_id     TEXT PRIMARY KEY,              -- e.g. 'mateo', 'chatgpt'
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('mateo', 'agent')),
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER                        -- NULL = active
);
CREATE INDEX IF NOT EXISTS idx_agent_identities_role
  ON agent_identities (role);

CREATE TABLE IF NOT EXISTS agent_tokens (
  token_id     TEXT PRIMARY KEY,              -- public prefix, e.g. 'tok_...'
  agent_id     TEXT NOT NULL,                 -- -> agent_identities.agent_id
  secret_hash  TEXT NOT NULL,                 -- hex SHA-256 of the secret part
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,                 -- principal that issued it
  last_used_at INTEGER,
  revoked_at   INTEGER                        -- NULL = live
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent
  ON agent_tokens (agent_id);

CREATE TABLE IF NOT EXISTS david_sessions (
  session_hash   TEXT PRIMARY KEY,            -- hex SHA-256 of the session id
  github_user_id INTEGER NOT NULL,            -- numeric GitHub user id
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER                      -- NULL = live
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,               -- hex SHA-256 of the state value
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,               -- short-lived (10 min)
  used_at    INTEGER                          -- NULL = unused; single-use
);
