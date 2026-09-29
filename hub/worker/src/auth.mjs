// auth.mjs — authentication + authorization (task 008).
//
// Two credential kinds, one principal model:
//
//   * David (the human): GitHub OAuth, allowlisted by NUMERIC GitHub user id
//     (env DAVID_GITHUB_ID — never a username). Session = random 256-bit id
//     in a Secure/HttpOnly/SameSite cookie; only its SHA-256 is stored.
//   * Agents: bearer tokens in `token_id.secret` format. Only token_id,
//     agent_id, and the SHA-256 of the secret are stored — the plaintext
//     secret is shown once at issuance and never persisted.
//
// Principals: { kind: 'david' } or { kind: 'agent', agent_id, role }.
// role is 'mateo' (lead) or 'agent' (everyone else).
//
// ChatGPT's 008 boundary (enforced here, consumed by the 009 command layer):
// actor_id and submitted_by are ALWAYS derived server-side from the
// authenticated principal via principalIdentity(). A caller-declared
// submitted_by in a request body is untrusted input and must be ignored.
// applyPrincipalIdentity() overwrites both fields so 009 cannot get this
// wrong by accident.
//
// All OAuth/signing secrets come from Worker secret storage (env), never
// from the repo and never from D1.

// (no node imports — WebCrypto only, so this runs in Workers unchanged)

// ---------------------------------------------------------------------------
// Small crypto helpers (WebCrypto — works in Workers and in Node >= 18).
// ---------------------------------------------------------------------------

const te = new TextEncoder();

export function randomBase64Url(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  // btoa of a binary string, then base64url-ify.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = te.encode(a);
  const bb = te.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Agent identities + bearer tokens.
// ---------------------------------------------------------------------------

const TOKEN_ID_PREFIX = 'tok_';
const TOKEN_ID_BYTES = 12;   // 16 base64url chars
const SECRET_BYTES = 32;     // 43 base64url chars

function tokenId() {
  return TOKEN_ID_PREFIX + randomBase64Url(TOKEN_ID_BYTES);
}

/**
 * Mint an agent identity (creating it if new) and a bearer token for it.
 * Returns { token_id, secret, token } where token = "token_id.secret".
 * The plaintext secret is returned ONLY here — it is never stored.
 * `by` is the issuing principal's label, recorded for audit.
 */
export async function issueAgentToken(db, { agent_id, display_name, role }, { by, now = Date.now() }) {
  if (!agent_id || typeof agent_id !== 'string') throw err('AUTH_BAD_AGENT_ID', 'agent_id is required');
  if (role !== 'mateo' && role !== 'agent') throw err('AUTH_BAD_ROLE', 'role must be mateo or agent');
  const id = tokenId();
  const secret = randomBase64Url(SECRET_BYTES);
  const secretHash = await sha256Hex(secret);

  const existing = await db.queryOne('SELECT agent_id, role, disabled_at FROM agent_identities WHERE agent_id = ?', [agent_id]);
  if (existing) {
    if (existing.disabled_at) throw err('AUTH_AGENT_DISABLED', `agent ${agent_id} is disabled`);
    if (existing.role !== role) throw err('AUTH_ROLE_MISMATCH', `agent ${agent_id} already exists with role ${existing.role}`);
  } else {
    await db.batch([{
      sql: 'INSERT INTO agent_identities (agent_id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, NULL)',
      params: [agent_id, display_name || agent_id, role, now],
    }]);
  }
  await db.batch([{
    sql: 'INSERT INTO agent_tokens (token_id, agent_id, secret_hash, created_at, created_by, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
    params: [id, agent_id, secretHash, now, by],
  }]);
  return { token_id: id, secret, token: `${id}.${secret}` };
}

/** Rotate-before-revoke: revoke the old token only after the new one is issued. */
export async function revokeAgentToken(db, tokenId, { by, now = Date.now() } = {}) {
  const row = await db.queryOne('SELECT token_id, revoked_at FROM agent_tokens WHERE token_id = ?', [tokenId]);
  if (!row) throw err('AUTH_UNKNOWN_TOKEN', 'no such token');
  if (!row.revoked_at) {
    await db.batch([{
      sql: 'UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ?',
      params: [now, tokenId],
    }]);
  }
  return { ok: true, token_id: tokenId, revoked_by: by };
}

/**
 * Authenticate a request. Bearer token first, then David's session cookie.
 * Returns a principal { kind: 'david' } | { kind: 'agent', agent_id, role },
 * or null when no usable credential is present.
 * Throws AUTH_* on a credential that is present but invalid.
 */
export async function authenticate(db, request, { now = Date.now() } = {}) {
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return authenticateBearer(db, m[1].trim(), { now });
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId) return authenticateSession(db, sessionId, { now });
  return null;
}

async function authenticateBearer(db, token, { now }) {
  const dot = token.indexOf('.');
  const tokenId = dot > 0 ? token.slice(0, dot) : '';
  const secret = dot > 0 ? token.slice(dot + 1) : '';
  if (!tokenId.startsWith(TOKEN_ID_PREFIX) || !secret) {
    throw err('AUTH_BAD_TOKEN', 'malformed bearer token');
  }
  const row = await db.queryOne(
    'SELECT token_id, agent_id, secret_hash, revoked_at, last_used_at FROM agent_tokens WHERE token_id = ?', [tokenId]);
  if (!row) throw err('AUTH_BAD_TOKEN', 'unknown bearer token');
  if (row.revoked_at) throw err('AUTH_TOKEN_REVOKED', 'bearer token has been revoked');
  const ident = await db.queryOne(
    'SELECT agent_id, role, disabled_at FROM agent_identities WHERE agent_id = ?', [row.agent_id]);
  if (!ident || ident.disabled_at) throw err('AUTH_AGENT_DISABLED', 'agent is disabled');
  if (!timingSafeEqual(await sha256Hex(secret), row.secret_hash)) {
    throw err('AUTH_BAD_TOKEN', 'bearer token secret mismatch');
  }
  // $0 quota: last_used_at is a D1 write on every authenticated request, and
  // polling reads would burn the 100k/day free write budget on bookkeeping
  // alone (6 agents x 5s polling ~= 103k writes/day). Only touch it when the
  // stored value is stale (>10 min) — recency precision is not needed.
  if (!row.last_used_at || now - row.last_used_at > 10 * 60 * 1000) {
    await db.batch([{
      sql: 'UPDATE agent_tokens SET last_used_at = ? WHERE token_id = ?',
      params: [now, tokenId],
    }]);
  }
  return { kind: 'agent', agent_id: ident.agent_id, role: ident.role };
}

async function authenticateSession(db, sessionId, { now }) {
  const row = await db.queryOne(
    'SELECT session_hash, github_user_id, expires_at, revoked_at FROM david_sessions WHERE session_hash = ?',
    [await sha256Hex(sessionId)]);
  if (!row) throw err('AUTH_BAD_SESSION', 'unknown session');
  if (row.revoked_at) throw err('AUTH_SESSION_REVOKED', 'session has been revoked');
  if (row.expires_at <= now) throw err('AUTH_SESSION_EXPIRED', 'session has expired');
  return { kind: 'david', github_user_id: row.github_user_id };
}

// ---------------------------------------------------------------------------
// Authorization matrix — enforced centrally, before any command handler.
// ---------------------------------------------------------------------------

// Command names are the 009 API surface. David can do everything; the sets
// below name what each agent role may do. Anything unlisted is denied.
// (009 renamed the 008 draft names — e.g. task.claim -> claimTask — and
// folded task.assign into claimTask's assignee option; the semantics are
// unchanged. Flagged for ChatGPT's 009 review.)
const MATEO_COMMANDS = new Set([
  'createTask',
  'claimTask',
  'startTask', 'blockTask',
  'postMessage',
  'submitResult', 'recordReview',
  'requestDecision',
  'postHandoff', 'attachArtifact',
  'setAgentStatus',
  'agent.issue', 'agent.revoke',
]);

const AGENT_COMMANDS = new Set([
  'claimTask',             // self-claim of unassigned tasks only (009 enforces)
  'startTask', 'blockTask',// own assigned tasks only (009 enforces)
  'submitResult',          // own in-progress tasks only (009 enforces)
  'requestDecision',       // request only — resolution is David-only
  'postMessage', 'postHandoff', 'attachArtifact',
  'setAgentStatus',        // own status only (009 enforces)
]);

// David-only: consequential decisions and overrides. An authenticated agent
// token must never reach these, and Mateo may not impersonate them.
const DAVID_ONLY_COMMANDS = new Set(['resolveDecision']);

export function authorize(principal, command) {
  if (!principal) return false;
  if (principal.kind === 'david') return true;
  if (principal.kind !== 'agent') return false;
  if (DAVID_ONLY_COMMANDS.has(command)) return false;
  if (principal.role === 'mateo') return MATEO_COMMANDS.has(command);
  return AGENT_COMMANDS.has(command);
}

// ---------------------------------------------------------------------------
// Server-derived identity — ChatGPT's 008 boundary.
// ---------------------------------------------------------------------------

/**
 * The ONLY trusted source of actor_id / submitted_by. The 009 command layer
 * must call applyPrincipalIdentity() on every inbound command and must
 * never copy these fields from the request body.
 */
export function principalIdentity(principal) {
  if (!principal) throw err('AUTH_REQUIRED', 'authentication required');
  if (principal.kind === 'david') return { actor_id: 'david', submitted_by: 'david' };
  if (principal.kind === 'agent') {
    return { actor_id: principal.agent_id, submitted_by: principal.agent_id };
  }
  throw err('AUTH_UNKNOWN_PRINCIPAL', 'unknown principal kind');
}

/**
 * Return a copy of the command with actor_id/submitted_by overwritten from
 * the authenticated principal. Any caller-supplied values are discarded —
 * a bearer token can never mint provenance as another principal.
 */
export function applyPrincipalIdentity(command, principal) {
  const ident = principalIdentity(principal);
  return { ...command, actor_id: ident.actor_id, submitted_by: ident.submitted_by };
}

// ---------------------------------------------------------------------------
// GitHub OAuth for David.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'hub_session';
const SESSION_BYTES = 48;              // 64 hex chars
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const OAUTH_STATE_BYTES = 32;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookie(value, maxAgeMs) {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Start the GitHub OAuth flow. Returns { redirectUrl, state } and persists
 * the hashed state (single-use, 10-minute expiry).
 */
export async function beginGitHubLogin(env, db, { now = Date.now() } = {}) {
  if (!env.GITHUB_CLIENT_ID || !env.OAUTH_REDIRECT_URI) {
    throw err('AUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured');
  }
  const state = randomBase64Url(OAUTH_STATE_BYTES);
  await db.batch([{
    sql: 'INSERT INTO oauth_states (state_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)',
    params: [await sha256Hex(state), now, now + OAUTH_STATE_TTL_MS],
  }]);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', ''); // identity only — we need the numeric user id
  return { redirectUrl: url.toString(), state };
}

/**
 * Complete the GitHub OAuth flow. fetchFn is injectable for tests
 * (defaults to global fetch). Returns { setCookie, github_user_id }.
 */
export async function completeGitHubLogin(env, db, { code, state }, { now = Date.now(), fetchFn = fetch } = {}) {
  if (!code || !state) throw err('AUTH_BAD_CALLBACK', 'code and state are required');
  const stateHash = await sha256Hex(state);
  const srow = await db.queryOne('SELECT state_hash, expires_at, used_at FROM oauth_states WHERE state_hash = ?', [stateHash]);
  if (!srow || srow.expires_at <= now || srow.used_at) {
    throw err('AUTH_STATE_INVALID', 'OAuth state is invalid, expired, or already used');
  }
  await db.batch([{
    sql: 'UPDATE oauth_states SET used_at = ? WHERE state_hash = ?',
    params: [now, stateHash],
  }]);

  // Exchange the code for an access token.
  let tokenJson;
  try {
    const resp = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: env.OAUTH_REDIRECT_URI,
      }),
    });
    tokenJson = await resp.json();
  } catch (e) {
    throw err('AUTH_EXCHANGE_FAILED', 'GitHub token exchange failed');
  }
  const accessToken = tokenJson && tokenJson.access_token;
  if (!accessToken) throw err('AUTH_EXCHANGE_FAILED', 'GitHub did not return an access token');

  // Identify the GitHub user — numeric id only, never the username.
  let userJson;
  try {
    const resp = await fetchFn('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'ai-hub',
      },
    });
    userJson = await resp.json();
  } catch (e) {
    throw err('AUTH_USERINFO_FAILED', 'GitHub user lookup failed');
  }
  const githubId = Number(userJson && userJson.id);
  if (!Number.isInteger(githubId) || githubId <= 0) {
    throw err('AUTH_USERINFO_FAILED', 'GitHub did not return a numeric user id');
  }
  if (String(githubId) !== String(env.DAVID_GITHUB_ID)) {
    throw err('AUTH_NOT_ALLOWLISTED', 'GitHub user is not allowlisted');
  }

  const sessionId = randomHex(SESSION_BYTES); // 96 hex chars
  await db.batch([{
    sql: 'INSERT INTO david_sessions (session_hash, github_user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
    params: [await sha256Hex(sessionId), githubId, now, now + SESSION_TTL_MS],
  }]);
  return { setCookie: sessionCookie(sessionId, SESSION_TTL_MS), github_user_id: githubId };
}

/** Revoke David's session (logout). */
export async function logout(db, request, { now = Date.now() } = {}) {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId) {
    await db.batch([{
      sql: 'UPDATE david_sessions SET revoked_at = ? WHERE session_hash = ?',
      params: [now, await sha256Hex(sessionId)],
    }]);
  }
  return { ok: true, clearCookie: clearSessionCookie() };
}

// ---------------------------------------------------------------------------
// Error helper — stable machine-readable codes (same convention as 007).
// ---------------------------------------------------------------------------

export function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}
