-- 0003_mcp_oauth.sql — OAuth 2.1 issuance ceremony for the MCP server (task 020)
--
-- ADDITIVE ONLY: new tables, no change to 0001/0002 tables.
--
-- Design notes:
-- * OAuth is only the issuance ceremony. The access token it hands out is a
--   normal hub agent bearer token (agent_tokens, 0002), verified by the
--   unchanged authenticate() path. Nothing here is consulted on /mcp.
-- * Authorization codes and refresh tokens are random 256-bit values; only
--   their SHA-256 is stored. Single use is enforced with a claim nonce
--   (conditional UPDATE, then read back) because D1 batch() reports no
--   row counts.
-- * A refresh-token family is one approval: every refresh token and every
--   access token (agent_tokens.token_id) minted from it. Reuse of a spent
--   refresh token or a replayed code revokes the whole family.
-- * No foreign keys, INTEGER unix-ms timestamps — same conventions as 0001/0002.

-- RFC 7591 dynamically registered clients (public clients: no secret).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,             -- 'mcpc_...'
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                -- JSON array, exact-match allowlisted
  created_at    INTEGER NOT NULL
);

-- A pending /oauth/authorize request awaiting David's consent. request_id is
-- a handle, not a credential: approval also needs David's session and the
-- per-render CSRF token.
CREATE TABLE IF NOT EXISTS oauth_authorize_requests (
  request_id        TEXT PRIMARY KEY,         -- 'oar_...'
  client_id         TEXT NOT NULL,
  redirect_uri      TEXT NOT NULL,
  code_challenge    TEXT NOT NULL,            -- PKCE S256
  state             TEXT,                     -- client state, echoed back
  scope             TEXT,
  resource          TEXT,
  github_state_hash TEXT,                     -- links the GitHub login round trip
  csrf_hash         TEXT,                     -- SHA-256 of the consent form token
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,         -- 10 min
  used_at           INTEGER,
  claim             TEXT                      -- single-use claim nonce
);
CREATE INDEX IF NOT EXISTS idx_oauth_authorize_requests_gh
  ON oauth_authorize_requests (github_state_hash);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,            -- hex SHA-256 of the code
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  agent_id       TEXT NOT NULL,               -- bound at David's approval
  scope          TEXT,
  resource       TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,            -- 10 min
  used_at        INTEGER,
  claim          TEXT,
  family_id      TEXT                         -- set once tokens are issued
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash      TEXT PRIMARY KEY,           -- hex SHA-256 of the refresh token
  family_id       TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  access_token_id TEXT NOT NULL,              -- agent_tokens.token_id minted with it
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,           -- 30 days
  used_at         INTEGER,
  claim           TEXT,
  revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);
