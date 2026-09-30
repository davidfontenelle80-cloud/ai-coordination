// index.mjs — Worker entry point.
//
// Task 008: auth routes are live.
// Task 009: domain command + query API over ordinary HTTP.
//
// Routes:
//   GET  /auth/github/login     -> 302 to GitHub authorize
//   GET  /auth/github/callback  -> validate state, exchange code, set session
//   POST /auth/logout           -> revoke session, clear cookie
//   GET  /auth/me               -> current principal (or 401)
//   POST /auth/agents           -> issue agent bearer token (David-only;
//                                 plaintext token shown ONCE in the response)
//   POST /auth/agents/revoke    -> revoke an agent bearer token (David-only)
//   GET  /auth/agents/tokens     -> token metadata inventory (David-only;
//                                 never includes secret material)
//   POST /api/commands          -> execute one domain command (auth + rate limit)
//   GET  /api/tasks            -> list tasks (?status=&assignee=)
//   GET  /api/tasks/{id}       -> one task
//   GET  /api/tasks/{id}/events -> task events (?after_seq=)
//   GET  /api/tasks/{id}/resume -> handoff packet
//   GET  /api/activity         -> recent events
//   GET  /api/decisions        -> decisions (?state=requested|resolved)
//   GET  /api/agents           -> live agent status projection
//   GET  /api/stats            -> quota/what-we-control indicators (task 010)
//   POST /mcp                  -> MCP server (task 019): JSON-RPC 2.0 over
//                                 Streamable HTTP, stateless, agent bearer
//                                 only; tools = the query + command surface
//   GET  /                    -> dashboard HTML (David-only; task 010)
//   GET  /dashboard            -> dashboard HTML (David-only)
//   GET  /dashboard/app.js     -> dashboard JS (David-only)
//   GET  /dashboard/styles.css -> dashboard CSS (David-only)
//   GET  /dashboard/manifest.webmanifest -> PWA manifest (David-only; task 015)
//   GET  /dashboard/icons/*.png -> app icons (David-only; task 015)
//   GET  /favicon.ico          -> favicon (David-only; task 015)
//
// Env: DB (D1), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (secrets),
//      DAVID_GITHUB_ID (numeric), OAUTH_REDIRECT_URI.

import { d1Db } from './d1-db.mjs';
import {
  authenticate, issueAgentToken, revokeAgentToken, listAgentTokens,
  beginGitHubLogin, completeGitHubLogin, logout, err,
} from './auth.mjs';
import { executeCommand, COMMANDS } from './commands.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { runQuery } from './queries.mjs';
import { handleJsonRpc } from './mcp.mjs';
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from './dashboard.mjs';
import { MANIFEST_JSON, iconBytes } from './icons.mjs';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// Map stable AUTH_* codes to HTTP status. Auth failures are 401, forbidden
// actions are 403, bad input is 400, upstream GitHub failures are 502.
function authHttpStatus(e) {
  const code = e && e.code;
  if (code === 'AUTH_NOT_ALLOWLISTED') return 403;
  if (code === 'AUTH_BAD_CALLBACK' || code === 'AUTH_STATE_INVALID') return 400;
  if (code === 'AUTH_EXCHANGE_FAILED' || code === 'AUTH_USERINFO_FAILED') return 502;
  if (code === 'AUTH_NOT_CONFIGURED' || code === 'AUTH_BAD_AGENT_ID' ||
      code === 'AUTH_BAD_ROLE' || code === 'AUTH_ROLE_MISMATCH' ||
      code === 'AUTH_UNKNOWN_TOKEN') return 400;
  return 401;
}

function authError(e) {
  const status = authHttpStatus(e);
  return json({ ok: false, code: e.code || 'AUTH_ERROR', message: e.message }, status);
}

export default {
  async fetch(request, env) {
    const db = d1Db(env.DB);
    const url = new URL(request.url);
    const path = url.pathname;
    // Task 016: detect bearer attempts up front so the error path below can
    // rate-limit brute-force guessing (only failures are counted).
    const isBearerAttempt = /^Bearer\s+/i.test((request.headers.get('authorization') || '').trim());

    try {
      // -- GitHub OAuth -------------------------------------------------
      if (path === '/auth/github/login' && request.method === 'GET') {
        const { redirectUrl } = await beginGitHubLogin(env, db);
        return Response.redirect(redirectUrl, 302);
      }

      if (path === '/auth/github/callback' && request.method === 'GET') {
        const { setCookie, github_user_id } = await completeGitHubLogin(env, db, {
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
        });
        return json({ ok: true, github_user_id }, 200, { 'set-cookie': setCookie });
      }

      if (path === '/auth/logout' && request.method === 'POST') {
        const { clearCookie } = await logout(db, request);
        return json({ ok: true }, 200, { 'set-cookie': clearCookie });
      }

      // -- Authenticated auth-management routes -------------------------
      if (path === '/auth/me' && request.method === 'GET') {
        const principal = await authenticate(db, request);
        if (!principal) return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
        return json({ ok: true, principal: sanitizePrincipal(principal) });
      }

      // -- Agent token admin (task 016): David-only. Plaintext tokens are
      // shown ONCE here and never stored — only the SHA-256 hash persists.
      if (path === '/auth/agents' && request.method === 'POST') {
        const principal = await authenticate(db, request);
        if (!principal) return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
        if (principal.kind !== 'david') {
          return json({ ok: false, code: 'FORBIDDEN', message: 'token issuance is David-only' }, 403);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, code: 'BAD_REQUEST', message: 'JSON body required' }, 400);
        }
        const issued = await issueAgentToken(db,
          { agent_id: body.agent_id, display_name: body.display_name, role: body.role || 'agent' },
          { by: 'david' });
        // Plaintext token is shown ONCE — it is never stored and cannot be
        // retrieved again. The caller must copy it now.
        return json({ ok: true, token_id: issued.token_id, agent_id: body.agent_id, token: issued.token }, 201);
      }

      if (path === '/auth/agents/revoke' && request.method === 'POST') {
        const principal = await authenticate(db, request);
        if (!principal) return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
        if (principal.kind !== 'david') {
          return json({ ok: false, code: 'FORBIDDEN', message: 'token revocation is David-only' }, 403);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, code: 'BAD_REQUEST', message: 'JSON body required' }, 400);
        }
        if (!body.token_id || typeof body.token_id !== 'string') {
          return json({ ok: false, code: 'VALIDATION_FAILED', message: 'token_id is required' }, 400);
        }
        const revoked = await revokeAgentToken(db, body.token_id, { by: 'david' });
        return json({ ok: true, ...revoked }, 200);
      }

      // Task 017: David-only token inventory. Metadata only — listAgentTokens
      // never selects secret_hash, and the plaintext secret is not stored,
      // so nothing sensitive can leave through this route.
      if (path === '/auth/agents/tokens' && request.method === 'GET') {
        const principal = await authenticate(db, request);
        if (!principal) return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
        if (principal.kind !== 'david') {
          return json({ ok: false, code: 'FORBIDDEN', message: 'token inventory is David-only' }, 403);
        }
        return json({ ok: true, tokens: await listAgentTokens(db) }, 200);
      }

      // -- Command API (task 009) ------------------------------------
      if (path === '/api/commands' && request.method === 'POST') {
        // await (not bare return): async rejections must pass through the
        // try/catch below, otherwise unexpected errors escape as unhandled
        // rejections instead of 500s.
        return await handleCommand(request, db);
      }

      // -- MCP server (task 019) ----------------------------------------
      // Streamable HTTP, stateless, POST only: no SSE stream is offered, so
      // GET (and anything else) is 405 as the MCP transport spec requires.
      if (path === '/mcp') {
        if (request.method !== 'POST') {
          return json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: '/mcp accepts POST only' },
            405, { allow: 'POST' });
        }
        return await handleMcp(request, db);
      }

      // -- Query API (task 009) ----------------------------------------
      if (path.startsWith('/api/') && request.method === 'GET') {
        return await handleQuery(request, db, url);
      }

      // -- Dashboard UI (task 010) ---------------------------------------
      // David's control tower: David-only. Unauthenticated browsers go to
      // the GitHub login; authenticated non-David principals get 403.
      if (request.method === 'GET' && (path === '/' || path === '/dashboard')) {
        return await serveDashboard(request, db, 'text/html; charset=utf-8', DASHBOARD_HTML);
      }
      if (request.method === 'GET' && path === '/dashboard/app.js') {
        return await serveDashboard(request, db, 'application/javascript; charset=utf-8', DASHBOARD_JS);
      }
      if (request.method === 'GET' && path === '/dashboard/styles.css') {
        return await serveDashboard(request, db, 'text/css; charset=utf-8', DASHBOARD_CSS);
      }

      // -- App icons + web manifest (task 015) ---------------------------
      // David-only, like the other dashboard assets.
      if (request.method === 'GET' && path === '/favicon.ico') {
        return await serveIcon(request, db, 'favicon');
      }
      if (request.method === 'GET' && path === '/dashboard/manifest.webmanifest') {
        return await serveDashboard(request, db, 'application/manifest+json; charset=utf-8',
          JSON.stringify(MANIFEST_JSON));
      }
      if (request.method === 'GET' && path.startsWith('/dashboard/icons/') && path.endsWith('.png')) {
        const name = path.slice('/dashboard/icons/'.length, -'.png'.length);
        return await serveIcon(request, db, name);
      }

      // -- Unknown ------------------------------------------------------
      return json(
        { ok: false, code: 'NOT_FOUND', message: `no route ${request.method} ${path}` },
        404,
      );
    } catch (e) {
      // Only KNOWN auth errors map to auth responses. Anything else — a SQL
      // error, a decode failure, a programming bug — must not masquerade as
      // an authentication failure. (ChatGPT 009 review.)
      if (e && typeof e.code === 'string' && e.code.startsWith('AUTH_')) {
        // Task 016 brute-force protection: a burst of failed bearer attempts
        // from one IP is throttled. Successful logins never touch this
        // bucket, so legitimate polling agents are unaffected.
        if (isBearerAttempt && BEARER_FAIL_CODES.has(e.code)) {
          const ip = request.headers.get('cf-connecting-ip') || 'unknown';
          const brl = bearerFailLimiter.check(`bearer-fail:${ip}`);
          if (!brl.ok) {
            return json({
              ok: false, code: 'RATE_LIMITED',
              message: `too many failed authentication attempts; retry in ${Math.ceil(brl.retryAfterMs / 1000)}s`,
              retryable: true, retry_after_ms: brl.retryAfterMs,
            }, 429, { 'retry-after': String(Math.ceil(brl.retryAfterMs / 1000)) });
          }
        }
        return authError(e);
      }
      console.error('unhandled worker error:', e);
      return json({ ok: false, code: 'INTERNAL_ERROR', message: 'internal error' }, 500);
    }
  },
};

// Command HTTP status by error code.
function commandHttpStatus(code) {
  switch (code) {
    case 'AUTH_REQUIRED': return 401;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'VALIDATION_FAILED': return 400;
    case 'VERSION_CONFLICT':
    case 'TASK_ALREADY_CLAIMED':
    case 'INVALID_TRANSITION':
    case 'PROJECTION_CONFLICT': return 409;
    case 'RATE_LIMITED': return 429;
    default: return 500;
  }
}

const MAX_COMMAND_BYTES = 1024 * 1024; // 1 MiB
const commandLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

// Task 016: brute-force guard for bearer tokens. Counts FAILED bearer
// attempts per client IP only — 20/min is far above any legitimate client,
// and successful authentications never increment the counter.
const bearerFailLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
const BEARER_FAIL_CODES = new Set(['AUTH_BAD_TOKEN', 'AUTH_TOKEN_REVOKED', 'AUTH_AGENT_DISABLED']);

async function handleCommand(request, db) {
  const principal = await authenticate(db, request);
  if (!principal) {
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }

  const limited = checkCommandRate(principal);
  if (limited) {
    return json(limited, 429, { 'retry-after': String(Math.ceil(limited.retry_after_ms / 1000)) });
  }

  const read = await readCappedBody(request);
  if (read.tooLarge) {
    return json({ ok: false, code: 'VALIDATION_FAILED', message: 'command body exceeds 1 MiB' }, 400);
  }
  let body;
  try {
    body = JSON.parse(read.text ?? ''); // unreadable body -> parse error, as before 019
  } catch {
    return json({ ok: false, code: 'VALIDATION_FAILED', message: 'JSON body required' }, 400);
  }

  const result = await executeCommand(db, principal, body);
  if (result.ok) return json(result, 200);
  return json(result, commandHttpStatus(result.code));
}

// Per-principal command rate limit, shared by POST /api/commands and MCP
// command tools (task 019) — one bucket per principal across both surfaces.
// Returns null when allowed, or the hub RATE_LIMITED error body.
function checkCommandRate(principal) {
  const key = principal.kind === 'david' ? 'david' : `agent:${principal.agent_id}`;
  const rl = commandLimiter.check(key);
  if (rl.ok) return null;
  return {
    ok: false, code: 'RATE_LIMITED',
    message: `command rate limit exceeded; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
    retryable: true, retry_after_ms: rl.retryAfterMs,
  };
}

// Read a request body under the 1 MiB cap. Returns { text } or
// { tooLarge: true }; a body that cannot be read yields text: null.
async function readCappedBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_COMMAND_BYTES) return { tooLarge: true };
  let text;
  try {
    // Enforce the 1 MiB cap on actual bytes read, not just the header —
    // a request without Content-Length must not bypass the contract.
    // (ChatGPT 009 review, minor hardening.)
    text = await request.text();
  } catch {
    return { text: null };
  }
  if (new TextEncoder().encode(text).length > MAX_COMMAND_BYTES) return { tooLarge: true };
  return { text };
}

// -- MCP (task 019) ---------------------------------------------------------
// POST /mcp: stateless MCP Streamable HTTP. Every request carries its own
// agent bearer token and goes through the SAME authenticate() as the REST
// API: invalid/revoked tokens throw AUTH_* into the fetch() catch, which
// maps them to the same 401 bodies and feeds the same bearer brute-force
// limiter. David's session cookie is deliberately not accepted here.
async function handleMcp(request, db) {
  const header = (request.headers.get('authorization') || '').trim();
  if (!/^Bearer\s+/i.test(header)) {
    // Without a bearer header authenticate() would fall back to the David
    // session cookie — MCP clients are agents, so stop here instead.
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }
  const principal = await authenticate(db, request);
  if (!principal || principal.kind !== 'agent') {
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }

  const read = await readCappedBody(request);
  const res = await handleJsonRpc(db, principal, read.tooLarge ? { tooLarge: true } : read.text, {
    checkCommandRate,
    protocolVersion: request.headers.get('mcp-protocol-version'),
  });
  if (res.body === undefined) return new Response(null, { status: res.status });
  return json(res.body, res.status);
}

async function handleQuery(request, db, url) {
  const principal = await authenticate(db, request);
  if (!principal) {
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }

  const route = matchQueryRoute(url);
  if (!route) {
    return json({ ok: false, code: 'NOT_FOUND', message: `no route GET ${url.pathname}` }, 404);
  }
  // Task 019: one dispatch table (queries.mjs QUERIES) serves both REST and
  // MCP, so the two surfaces cannot drift. Query failures are NOT_FOUND.
  const result = await runQuery(db, route.name, route.args);
  return json(result, result.ok ? 200 : 404);
}

// Map a GET /api/* path to a QUERIES entry plus its arguments. Query-string
// values arrive as strings (or null when absent), exactly as before 019.
function matchQueryRoute(url) {
  const segs = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = (name) => url.searchParams.get(name);

  // GET /api/tasks
  if (segs.length === 2 && segs[1] === 'tasks') {
    return { name: 'list_tasks', args: { status: q('status'), assignee: q('assignee'), limit: q('limit') } };
  }
  // GET /api/tasks/{id}[/events|/resume]
  if (segs.length >= 3 && segs[1] === 'tasks') {
    const task_id = decodeURIComponent(segs[2]);
    if (segs.length === 3) return { name: 'get_task', args: { task_id } };
    if (segs.length === 4 && segs[3] === 'events') {
      return { name: 'get_task_events', args: { task_id, after_seq: q('after_seq'), limit: q('limit') } };
    }
    if (segs.length === 4 && segs[3] === 'resume') return { name: 'get_task_resume', args: { task_id } };
  }
  if (segs.length === 2 && segs[1] === 'activity') return { name: 'get_activity', args: { limit: q('limit') } };
  if (segs.length === 2 && segs[1] === 'decisions') return { name: 'list_decisions', args: { state: q('state') } };
  if (segs.length === 2 && segs[1] === 'agents') return { name: 'list_agents', args: {} };
  if (segs.length === 2 && segs[1] === 'stats') return { name: 'get_stats', args: {} }; // task 010
  return null;
}

// Never leak internal principal fields to clients.
function sanitizePrincipal(p) {
  if (p.kind === 'david') return { kind: 'david' };
  return { kind: 'agent', agent_id: p.agent_id, role: p.role };
}

// Dashboard assets (task 010): David-only. Unauthenticated requests are
// redirected to the GitHub login; authenticated non-David principals are
// refused — this is David's control tower, not a team surface.
async function serveDashboard(request, db, contentType, body) {
  const principal = await authenticate(db, request);
  if (!principal) {
    return Response.redirect(new URL('/auth/github/login', request.url), 302);
  }
  if (principal.kind !== 'david') {
    return json({ ok: false, code: 'FORBIDDEN', message: 'dashboard is David-only' }, 403);
  }
  return new Response(body, {
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
}

// App icon assets (task 015): David-only, like the other dashboard assets.
// Unknown icon names are 404 even before the auth check — the names are
// public (they appear in the manifest).
async function serveIcon(request, db, name) {
  const icon = iconBytes(name);
  if (!icon) {
    return json({ ok: false, code: 'NOT_FOUND', message: `no icon ${name}` }, 404);
  }
  const principal = await authenticate(db, request);
  if (!principal) {
    return Response.redirect(new URL('/auth/github/login', request.url), 302);
  }
  if (principal.kind !== 'david') {
    return json({ ok: false, code: 'FORBIDDEN', message: 'dashboard is David-only' }, 403);
  }
  return new Response(icon.bytes, {
    headers: { 'content-type': icon.contentType, 'cache-control': 'public, max-age=86400' },
  });
}
