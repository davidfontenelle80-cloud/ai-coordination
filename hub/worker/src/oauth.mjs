/**
 * oauth.mjs — task 020 OAuth 2.1 issuance ceremony for the MCP server.
 *
 * Claude's custom connector is OAuth-only, so this module lets it obtain a
 * hub agent bearer token through a standards-based flow:
 *
 *   RFC 9728 protected-resource metadata -> RFC 8414 AS metadata ->
 *   RFC 7591 dynamic client registration -> authorization code + PKCE (S256)
 *   with David's GitHub identity and explicit agent_id approval ->
 *   token exchange -> refresh with rotation and reuse detection.
 *
 * The elegant core: the access token issued here IS a normal agent bearer
 * token, minted by issueAgentToken() into agent_tokens (hash-only storage)
 * and verified on /mcp by the UNCHANGED authenticate(). Nothing in this
 * module is consulted when a request is authenticated. David can see and
 * revoke OAuth-issued tokens in the existing token inventory.
 *
 * Binding: the agent_id is chosen by David on the consent screen and stored
 * on the authorization code; the token endpoint mints for exactly that
 * agent_id and accepts no agent_id from the client. Refreshes stay in the
 * family and keep the same agent_id. Only role 'agent' identities can be
 * issued through OAuth — never a Mateo-role identity, never David.
 */

import {
  authenticate, beginGitHubLogin, issueAgentToken, revokeAgentToken,
  randomBase64Url, sha256Hex, timingSafeEqual,
} from './auth.mjs';

// Redirect URIs a client may register: Claude's hosted-app callback, plus
// the claude.com callback Anthropic has announced it may move to. ChatGPT's
// desktop/plugin connector mints a per-connection callback of the form
// https://chatgpt.com/connector/oauth/<opaque-id>, which can never be
// enumerated in advance, so it is accepted by predicate (exact host, exact
// The legacy fixed ChatGPT callback is also accepted, as are RFC 8252 §7.3
// loopback redirects (http://localhost:<port>/...) for native desktop
// clients such as ChatGPT desktop. Any other client remains out of scope
// and is refused at registration.
export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

const CHATGPT_DYNAMIC_CB_RE = /^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/;

// True for ChatGPT's per-connection OAuth callbacks. Exported for tests.
export function isChatGptCallback(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.host === 'chatgpt.com'
    && !u.username && !u.password && !u.search && !u.hash
    && CHATGPT_DYNAMIC_CB_RE.test(u.pathname);
}

// True for RFC 8252 §7.3 loopback redirects used by native desktop clients
// (ChatGPT desktop binds an ephemeral port and sends
// http://localhost:<port>/callback). http only, loopback host only, any port,
// bounded path, no userinfo / query / fragment. The redirect can only reach
// the user's own machine, so this is the standard native-app pattern.
// Exported for tests.
export function isLoopbackRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  if (u.username || u.password || u.search || u.hash) return false;
  return u.pathname.length > 0 && u.pathname.length <= 200;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const RANDOM_BYTES = 32; // 256-bit codes, refresh tokens, CSRF tokens
const MAX_BODY_BYTES = 64 * 1024;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const OAUTH_CREATED_BY = 'david-oauth';

export const MCP_PATH = '/mcp';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// Token responses must never be cached (RFC 6749 §5.1).
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

const oauthError = (error, error_description, status = 400) =>
  json({ error, error_description }, status, NO_STORE);

export function resourceUrl(origin) {
  return origin + MCP_PATH;
}

export function resourceMetadataUrl(origin) {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** WWW-Authenticate value for /mcp 401s (MCP authorization discovery). */
export function mcpWwwAuthenticate(origin) {
  return `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`;
}

// PKCE S256: BASE64URL(SHA256(ASCII(code_verifier))).
async function pkceS256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let s = '';
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const normalizeResource = (r) => (typeof r === 'string' ? r.replace(/\/+$/, '') : r);

// ---------------------------------------------------------------------------
// Single-use claims. D1 batch() reports no row counts, so a claim is a
// conditional UPDATE with a fresh nonce followed by a read-back: exactly one
// concurrent caller sees its own nonce.
// ---------------------------------------------------------------------------

async function claimRow(db, table, keyCol, key, now) {
  const nonce = randomBase64Url(16);
  await db.batch([{
    sql: `UPDATE ${table} SET used_at = ?, claim = ? WHERE ${keyCol} = ? AND used_at IS NULL`,
    params: [now, nonce, key],
  }]);
  const row = await db.queryOne(`SELECT claim FROM ${table} WHERE ${keyCol} = ?`, [key]);
  return !!row && row.claim === nonce;
}

/** Revoke every refresh token and every access token in a family. */
async function revokeFamily(db, familyId, now) {
  if (!familyId) return;
  const rows = await db.queryAll(
    'SELECT access_token_id FROM oauth_refresh_tokens WHERE family_id = ?', [familyId]);
  await db.batch([{
    sql: 'UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
    params: [now, familyId],
  }]);
  for (const r of rows) {
    await revokeAgentToken(db, r.access_token_id, { by: 'oauth-family-revocation', now });
  }
}

// ---------------------------------------------------------------------------
// Metadata (RFC 9728, RFC 8414).
// ---------------------------------------------------------------------------

function protectedResourceMetadata(origin) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: 'AI Hub',
  };
}

function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------------------
// RFC 7591 dynamic client registration.
// ---------------------------------------------------------------------------

async function register(request, db, now) {
  const body = await readJson(request);
  if (!body) return oauthError('invalid_client_metadata', 'JSON body required');
  const { redirect_uris } = body;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return oauthError('invalid_redirect_uri', 'redirect_uris is required');
  }
  for (const uri of redirect_uris) {
    if (!ALLOWED_REDIRECT_URIS.includes(uri) && !isChatGptCallback(uri) && !isLoopbackRedirect(uri)) {
      return oauthError('invalid_redirect_uri', `redirect_uri not allowed: ${String(uri).slice(0, 200)}`);
    }
  }
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types)
      || body.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) {
    return oauthError('invalid_client_metadata', 'grant_types must be authorization_code and/or refresh_token');
  }
  if (body.response_types !== undefined && (!Array.isArray(body.response_types)
      || body.response_types.some((t) => t !== 'code'))) {
    return oauthError('invalid_client_metadata', 'response_types must be ["code"]');
  }
  const client_name = typeof body.client_name === 'string' && body.client_name.trim()
    ? body.client_name.trim().slice(0, 100) : 'MCP client';
  const client_id = 'mcpc_' + randomBase64Url(16);
  await db.batch([{
    sql: 'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
    params: [client_id, client_name, JSON.stringify(redirect_uris), now],
  }]);
  // Public client: we always register token_endpoint_auth_method "none"
  // (RFC 7591 lets the server replace requested values).
  return json({
    client_id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name,
    redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201, NO_STORE);
}

async function getClient(db, client_id) {
  if (typeof client_id !== 'string' || !client_id) return null;
  const row = await db.queryOne(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?', [client_id]);
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

// ---------------------------------------------------------------------------
// Authorization endpoint + David's consent.
// ---------------------------------------------------------------------------

function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

// David's principal from his session cookie, or null. Any bearer or
// invalid credential simply means "not David" here.
async function davidPrincipal(db, request) {
  try {
    const p = await authenticate(db, request);
    return p && p.kind === 'david' ? p : null;
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('AUTH_')) return null;
    throw e;
  }
}

async function authorizeGet(request, env, db, url, origin, now) {
  const q = (n) => url.searchParams.get(n);

  // Returning from GitHub login (or a reload): resume a pending request.
  const requestId = q('request');
  if (requestId) {
    const pending = await loadPending(db, requestId, now);
    if (!pending) return errorPage('This sign-in request has expired or was already used. Start again from Claude.', 400);
    return consentOrLogin(request, env, db, pending, origin, now);
  }

  // Client and redirect_uri are verified BEFORE anything can be redirected
  // (RFC 6749 §4.1.2.1): never bounce errors to an unverified URI.
  const client = await getClient(db, q('client_id'));
  if (!client) return errorPage('Unknown OAuth client.', 400);
  const redirect_uri = q('redirect_uri');
  if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    return errorPage('redirect_uri is not registered for this client.', 400);
  }
  const state = q('state');
  const fail = (error, desc) => redirectWith(redirect_uri, { error, error_description: desc, state, iss: origin });

  if (q('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const code_challenge = q('code_challenge');
  if (!code_challenge || q('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(code_challenge)) {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const resource = q('resource');
  if (resource && normalizeResource(resource) !== resourceUrl(origin)) {
    return fail('invalid_target', 'resource must be this server\'s MCP endpoint');
  }

  const pending = {
    request_id: 'oar_' + randomBase64Url(RANDOM_BYTES),
    client_id: client.client_id, redirect_uri, code_challenge,
    state, scope: q('scope'), resource: resource || null,
  };
  await db.batch([{
    sql: `INSERT INTO oauth_authorize_requests
          (request_id, client_id, redirect_uri, code_challenge, state, scope, resource,
           github_state_hash, csrf_hash, created_at, expires_at, used_at, claim)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
    params: [pending.request_id, pending.client_id, redirect_uri, code_challenge,
      state, pending.scope, pending.resource, now, now + REQUEST_TTL_MS],
  }]);
  return consentOrLogin(request, env, db, { ...pending, client_name: client.client_name }, origin, now);
}

async function loadPending(db, requestId, now) {
  const row = await db.queryOne(
    `SELECT r.*, c.client_name FROM oauth_authorize_requests r
     LEFT JOIN oauth_clients c ON c.client_id = r.client_id
     WHERE r.request_id = ?`, [requestId]);
  if (!row || row.used_at || row.expires_at <= now) return null;
  return row;
}

async function consentOrLogin(request, env, db, pending, origin, now, error) {
  if (!(await davidPrincipal(db, request))) {
    // Only David can approve. Send him through the existing GitHub login
    // (same OAuth app, same DAVID_GITHUB_ID allowlist); the callback sees
    // the linked state and brings him back here.
    const { redirectUrl, state } = await beginGitHubLogin(env, db, { now });
    await db.batch([{
      sql: 'UPDATE oauth_authorize_requests SET github_state_hash = ? WHERE request_id = ?',
      params: [await sha256Hex(state), pending.request_id],
    }]);
    return new Response(null, { status: 302, headers: { location: redirectUrl, 'cache-control': 'no-store' } });
  }
  // Fresh CSRF token per render, stored hashed; the form must echo it.
  const csrf = randomBase64Url(RANDOM_BYTES);
  await db.batch([{
    sql: 'UPDATE oauth_authorize_requests SET csrf_hash = ? WHERE request_id = ?',
    params: [await sha256Hex(csrf), pending.request_id],
  }]);
  return consentPage(pending, csrf, error);
}

/**
 * GitHub callback hook: if this GitHub state was started by /oauth/authorize,
 * return the URL to resume consent at; otherwise null (plain dashboard login).
 */
export async function oauthResumeUrlForGithubState(db, githubState, origin, { now = Date.now() } = {}) {
  if (!githubState) return null;
  const row = await db.queryOne(
    'SELECT request_id, used_at, expires_at FROM oauth_authorize_requests WHERE github_state_hash = ?',
    [await sha256Hex(githubState)]);
  if (!row || row.used_at || row.expires_at <= now) return null;
  return `${origin}/oauth/authorize?request=${encodeURIComponent(row.request_id)}`;
}

async function authorizePost(request, env, db, origin, now) {
  const form = await readForm(request);
  if (!form) return errorPage('Malformed form submission.', 400);
  if (!(await davidPrincipal(db, request))) return errorPage('Only David can approve MCP access.', 403);

  const pending = await loadPending(db, form.get('request') || '', now);
  if (!pending) return errorPage('This sign-in request has expired or was already used. Start again from Claude.', 400);
  const csrf = form.get('csrf') || '';
  if (!pending.csrf_hash || !timingSafeEqual(await sha256Hex(csrf), pending.csrf_hash)) {
    return errorPage('Consent form is stale or forged. Reload and try again.', 403);
  }

  const action = form.get('action');
  if (action === 'deny') {
    if (!(await claimRow(db, 'oauth_authorize_requests', 'request_id', pending.request_id, now))) {
      return errorPage('This sign-in request was already used.', 400);
    }
    return redirectWith(pending.redirect_uri, {
      error: 'access_denied', error_description: 'David denied the request', state: pending.state, iss: origin,
    });
  }
  if (action !== 'approve') return errorPage('Unknown action.', 400);

  // David's explicit agent_id choice — the binding for everything issued.
  const agentId = (form.get('agent_id') || '').trim();
  const problem = await agentIdProblem(db, agentId);
  if (problem) return consentOrLogin(request, env, db, pending, origin, now, problem);

  if (!(await claimRow(db, 'oauth_authorize_requests', 'request_id', pending.request_id, now))) {
    return errorPage('This sign-in request was already used.', 400);
  }
  const code = randomBase64Url(RANDOM_BYTES);
  await db.batch([{
    sql: `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, agent_id,
          scope, resource, created_at, expires_at, used_at, claim, family_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    params: [await sha256Hex(code), pending.client_id, pending.redirect_uri, pending.code_challenge,
      agentId, pending.scope, pending.resource, now, now + CODE_TTL_MS],
  }]);
  return redirectWith(pending.redirect_uri, { code, state: pending.state, iss: origin });
}

// OAuth may only mint ordinary-agent tokens: an existing identity must be
// role 'agent' and enabled; a new agent_id becomes a role 'agent' identity.
async function agentIdProblem(db, agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    return 'agent_id must be 1–64 characters: lowercase letters, digits, "-" or "_".';
  }
  const ident = await db.queryOne(
    'SELECT role, disabled_at FROM agent_identities WHERE agent_id = ?', [agentId]);
  if (ident && ident.role !== 'agent') {
    return `${agentId} is a ${ident.role}-role identity; OAuth can only issue ordinary agent tokens.`;
  }
  if (ident && ident.disabled_at) return `${agentId} is disabled.`;
  return null;
}

// ---------------------------------------------------------------------------
// Token endpoint.
// ---------------------------------------------------------------------------

async function token(request, db, origin, now, onFailure) {
  const form = await readForm(request);
  if (!form) return oauthError('invalid_request', 'form-encoded body required');
  // Public clients identify with client_id (body, or Basic username).
  let clientId = form.get('client_id');
  const basic = /^Basic\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
  if (!clientId && basic) {
    try { clientId = decodeURIComponent(atob(basic[1]).split(':')[0]); } catch { /* fall through */ }
  }
  const grant = form.get('grant_type');
  const failed = async (error, desc, status = 400) => (await onFailure(request)) || oauthError(error, desc, status);

  if (!clientId) return failed('invalid_client', 'client_id is required', 401);
  const client = await getClient(db, clientId);
  if (!client) return failed('invalid_client', 'unknown client', 401);

  if (grant === 'authorization_code') return exchangeCode(db, form, client, origin, now, failed);
  if (grant === 'refresh_token') return refresh(db, form, client, origin, now, failed);
  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

async function exchangeCode(db, form, client, origin, now, failed) {
  const code = form.get('code');
  const verifier = form.get('code_verifier');
  const redirect_uri = form.get('redirect_uri');
  if (!code || !verifier || !redirect_uri) {
    return failed('invalid_request', 'code, code_verifier and redirect_uri are required');
  }
  const codeHash = await sha256Hex(code);
  const row = await db.queryOne('SELECT * FROM oauth_codes WHERE code_hash = ?', [codeHash]);
  if (!row) return failed('invalid_grant', 'invalid authorization code');
  if (row.used_at) {
    // Replay: OAuth 2.1 §4.1.3 — revoke what the first exchange issued.
    await revokeFamily(db, row.family_id, now);
    return failed('invalid_grant', 'authorization code already used');
  }
  // Claim first: whatever fails below, the code is spent (one guess only).
  if (!(await claimRow(db, 'oauth_codes', 'code_hash', codeHash, now))) {
    return failed('invalid_grant', 'authorization code already used');
  }
  if (row.expires_at <= now) return failed('invalid_grant', 'authorization code expired');
  if (row.client_id !== client.client_id) return failed('invalid_grant', 'code was issued to another client');
  if (row.redirect_uri !== redirect_uri) return failed('invalid_grant', 'redirect_uri mismatch');
  if (!PKCE_VERIFIER_RE.test(verifier) || !timingSafeEqual(await pkceS256(verifier), row.code_challenge)) {
    return failed('invalid_grant', 'PKCE verification failed');
  }
  const resource = form.get('resource');
  if (resource && normalizeResource(resource) !== resourceUrl(origin)) {
    return failed('invalid_target', 'resource must be this server\'s MCP endpoint');
  }

  const familyId = 'fam_' + randomBase64Url(16);
  await db.batch([{ sql: 'UPDATE oauth_codes SET family_id = ? WHERE code_hash = ?', params: [familyId, codeHash] }]);
  // agent_id comes ONLY from the code David approved.
  return issueTokens(db, { familyId, client, agentId: row.agent_id, scope: row.scope, now }, failed);
}

async function refresh(db, form, client, origin, now, failed) {
  const presented = form.get('refresh_token');
  if (!presented) return failed('invalid_request', 'refresh_token is required');
  const tokenHash = await sha256Hex(presented);
  const row = await db.queryOne('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [tokenHash]);
  if (!row || row.client_id !== client.client_id) return failed('invalid_grant', 'invalid refresh token');
  if (row.revoked_at) return failed('invalid_grant', 'refresh token revoked');
  if (row.used_at || !(await claimRow(db, 'oauth_refresh_tokens', 'token_hash', tokenHash, now))) {
    // Reuse of a rotated-out token: assume theft, kill the whole family.
    await revokeFamily(db, row.family_id, now);
    return failed('invalid_grant', 'refresh token reuse detected; access revoked');
  }
  if (row.expires_at <= now) return failed('invalid_grant', 'refresh token expired');
  // If David revoked the current access token (dashboard inventory), a
  // refresh must not quietly mint a replacement: end the family.
  const current = await db.queryOne('SELECT revoked_at FROM agent_tokens WHERE token_id = ?', [row.access_token_id]);
  if (!current || current.revoked_at) {
    await revokeFamily(db, row.family_id, now);
    return failed('invalid_grant', 'access was revoked');
  }
  const res = await issueTokens(db,
    { familyId: row.family_id, client, agentId: row.agent_id, scope: null, now }, failed);
  // Rotate-before-revoke: the new token exists before the old one dies.
  if (res.status === 200) await revokeAgentToken(db, row.access_token_id, { by: 'oauth-rotation', now });
  return res;
}

async function issueTokens(db, { familyId, client, agentId, scope, now }, failed) {
  let issued;
  try {
    issued = await issueAgentToken(db,
      { agent_id: agentId, display_name: agentId, role: 'agent' },
      { by: OAUTH_CREATED_BY, now });
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('AUTH_')) {
      await revokeFamily(db, familyId, now);
      return failed('invalid_grant', `agent ${agentId} cannot be issued a token`);
    }
    throw e;
  }
  const refreshToken = 'hrt_' + randomBase64Url(RANDOM_BYTES);
  await db.batch([{
    sql: `INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, agent_id, access_token_id,
          created_at, expires_at, used_at, claim, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    params: [await sha256Hex(refreshToken), familyId, client.client_id, agentId, issued.token_id,
      now, now + REFRESH_TTL_MS],
  }]);
  // No expires_in: hub agent tokens carry no expiry (0002 is unchanged);
  // they end by rotation, family revocation, or David's revoke.
  return json({
    access_token: issued.token,
    token_type: 'Bearer',
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// Body helpers.
// ---------------------------------------------------------------------------

async function readText(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return null;
  let text;
  try { text = await request.text(); } catch { return null; }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  return text;
}

async function readForm(request) {
  const text = await readText(request);
  return text === null ? null : new URLSearchParams(text);
}

async function readJson(request) {
  const text = await readText(request);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pages (David-facing HTML). Every dynamic value is escaped.
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// form-action must include the redirect targets: browsers apply it to the
// 302 that follows the consent POST.
// RFC 8252 loopback callbacks (http://127.0.0.1:<port>/… etc.) use an
// ephemeral port, so the CSP needs port wildcards. Without these, Chrome
// blocks the 302 back to the desktop app and the approval silently dies on
// the consent page. Safe: the 302 target is always the client's own
// validated redirect_uri (see isLoopbackRedirect), never attacker-chosen.
const LOOPBACK_CSP_SOURCES = 'http://127.0.0.1:* http://localhost:* http://[::1]:*';
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; "
    + `form-action 'self' ${ALLOWED_REDIRECT_URIS.map((u) => new URL(u).origin).join(' ')} ${LOOPBACK_CSP_SOURCES}; `
    + "frame-ancestors 'none'; base-uri 'none'",
};

const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;color:#1b1b1f;background:#fff}
h1{font-size:1.3rem}.box{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:1rem 0}
.warn{background:#fff6e0;border-color:#e0b400}.err{background:#fde8e8;border-color:#d33}
label{display:block;font-weight:600;margin-top:1rem}input[type=text]{font:inherit;font-size:16px;width:100%;box-sizing:border-box;padding:10px;margin-top:4px}
button{font:inherit;min-height:44px;padding:0 18px;margin:1rem 8px 0 0;border-radius:6px;border:1px solid #888;background:#f4f4f4}
button.ok{background:#1b5e20;color:#fff;border-color:#1b5e20}code{word-break:break-all}`;

function page(title, bodyHtml, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${bodyHtml}</body></html>`,
    { status, headers: PAGE_HEADERS });
}

function errorPage(message, status) {
  return page('AI Hub — sign-in problem', `<h1>AI Hub sign-in</h1><div class="box err">${esc(message)}</div>`, status);
}

function consentPage(pending, csrf, error) {
  const host = new URL(pending.redirect_uri).host;
  return page('AI Hub — approve MCP access', `
<h1>Approve MCP access to AI Hub</h1>
${error ? `<div class="box err">${esc(error)}</div>` : ''}
<div class="box">
  <div><strong>${esc(pending.client_name || 'MCP client')}</strong> is asking for an agent token.</div>
  <div>Token will be sent to: <code>${esc(host)}</code></div>
</div>
<div class="box warn">Only approve if you just clicked <em>Connect</em> in Claude yourself.
The token acts as the agent you name below, with that agent's permissions only.
You can revoke it later from the dashboard's token list.</div>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${esc(pending.request_id)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label for="agent_id">Issue the token for agent_id</label>
  <input type="text" id="agent_id" name="agent_id" required placeholder="claude"
    autocomplete="off" autocapitalize="none" spellcheck="false" pattern="[a-z0-9][a-z0-9_\\-]{0,63}">
  <button class="ok" type="submit" name="action" value="approve">Approve</button>
  <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
</form>`);
}

// ---------------------------------------------------------------------------
// Router. Returns a Response for OAuth paths, or null for anything else.
// `onTokenFailure(request)` feeds the shared bearer brute-force limiter and
// returns a 429 Response when the caller is over the limit, else null.
// `onUnauthenticatedWrite(request)` rate-limits open endpoints that write
// rows (registration, new authorize requests); same contract.
// ---------------------------------------------------------------------------

export async function handleOAuth(request, env, db, url, { onTokenFailure, onUnauthenticatedWrite } = {}) {
  const path = url.pathname;
  const origin = url.origin;
  const method = request.method;
  const now = Date.now();
  const noLimit = async () => null;
  onTokenFailure = onTokenFailure || noLimit;
  onUnauthenticatedWrite = onUnauthenticatedWrite || noLimit;

  if (method === 'GET' && (path === '/.well-known/oauth-protected-resource'
      || path === `/.well-known/oauth-protected-resource${MCP_PATH}`)) {
    return json(protectedResourceMetadata(origin));
  }
  if (method === 'GET' && (path === '/.well-known/oauth-authorization-server'
      || path === `/.well-known/oauth-authorization-server${MCP_PATH}`)) {
    return json(authorizationServerMetadata(origin));
  }
  if (path === '/oauth/register') {
    if (method !== 'POST') return oauthError('invalid_request', 'POST only', 405);
    return (await onUnauthenticatedWrite(request)) || register(request, db, now);
  }
  if (path === '/oauth/authorize') {
    if (method === 'GET') {
      if (!url.searchParams.get('request')) {
        const limited = await onUnauthenticatedWrite(request);
        if (limited) return limited;
      }
      return authorizeGet(request, env, db, url, origin, now);
    }
    if (method === 'POST') return authorizePost(request, env, db, origin, now);
    return errorPage('Method not allowed.', 405);
  }
  if (path === '/oauth/token') {
    if (method !== 'POST') return oauthError('invalid_request', 'POST only', 405);
    return token(request, db, origin, now, onTokenFailure);
  }
  return null;
}
