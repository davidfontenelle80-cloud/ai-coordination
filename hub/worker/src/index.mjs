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
//   POST /auth/agents           -> issue agent bearer token (David/Mateo only;
//                                 plaintext token shown ONCE in the response)
//   POST /api/commands          -> execute one domain command (auth + rate limit)
//   GET  /api/tasks            -> list tasks (?status=&assignee=)
//   GET  /api/tasks/{id}       -> one task
//   GET  /api/tasks/{id}/events -> task events (?after_seq=)
//   GET  /api/tasks/{id}/resume -> handoff packet
//   GET  /api/activity         -> recent events
//   GET  /api/decisions        -> decisions (?state=requested|resolved)
//   GET  /api/agents           -> live agent status projection
//
// Env: DB (D1), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (secrets),
//      DAVID_GITHUB_ID (numeric), OAUTH_REDIRECT_URI.

import { d1Db } from './d1-db.mjs';
import {
  authenticate, authorize, issueAgentToken,
  beginGitHubLogin, completeGitHubLogin, logout, err,
} from './auth.mjs';
import { executeCommand, COMMANDS } from './commands.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import {
  listTasks, getTask, getTaskEvents, getResume,
  getActivity, listDecisions, listAgents,
} from './queries.mjs';

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

      if (path === '/auth/agents' && request.method === 'POST') {
        const principal = await authenticate(db, request);
        if (!principal) return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
        if (!authorize(principal, 'agent.issue')) {
          return json({ ok: false, code: 'FORBIDDEN', message: 'not permitted' }, 403);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, code: 'BAD_REQUEST', message: 'JSON body required' }, 400);
        }
        const by = principal.kind === 'david' ? 'david' : principal.agent_id;
        const issued = await issueAgentToken(db,
          { agent_id: body.agent_id, display_name: body.display_name, role: body.role },
          { by });
        // Plaintext token is shown ONCE — it is never stored and cannot be
        // retrieved again. The caller must copy it now.
        return json({ ok: true, token_id: issued.token_id, token: issued.token }, 201);
      }

      // -- Command API (task 009) ------------------------------------
      if (path === '/api/commands' && request.method === 'POST') {
        // await (not bare return): async rejections must pass through the
        // try/catch below, otherwise unexpected errors escape as unhandled
        // rejections instead of 500s.
        return await handleCommand(request, db);
      }

      // -- Query API (task 009) ----------------------------------------
      if (path.startsWith('/api/') && request.method === 'GET') {
        return await handleQuery(request, db, url);
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

async function handleCommand(request, db) {
  const principal = await authenticate(db, request);
  if (!principal) {
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }

  const key = principal.kind === 'david' ? 'david' : `agent:${principal.agent_id}`;
  const rl = commandLimiter.check(key);
  if (!rl.ok) {
    return json({
      ok: false, code: 'RATE_LIMITED',
      message: `command rate limit exceeded; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
      retryable: true, retry_after_ms: rl.retryAfterMs,
    }, 429, { 'retry-after': String(Math.ceil(rl.retryAfterMs / 1000)) });
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_COMMAND_BYTES) {
    return json({ ok: false, code: 'VALIDATION_FAILED', message: 'command body exceeds 1 MiB' }, 400);
  }

  let body;
  try {
    // Enforce the 1 MiB cap on actual bytes read, not just the header —
    // a request without Content-Length must not bypass the contract.
    // (ChatGPT 009 review, minor hardening.)
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_COMMAND_BYTES) {
      return json({ ok: false, code: 'VALIDATION_FAILED', message: 'command body exceeds 1 MiB' }, 400);
    }
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, code: 'VALIDATION_FAILED', message: 'JSON body required' }, 400);
  }

  const result = await executeCommand(db, principal, body);
  if (result.ok) return json(result, 200);
  return json(result, commandHttpStatus(result.code));
}

async function handleQuery(request, db, url) {
  const principal = await authenticate(db, request);
  if (!principal) {
    return json({ ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' }, 401);
  }

  const segs = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = (name) => url.searchParams.get(name);

  // GET /api/tasks
  if (segs.length === 2 && segs[1] === 'tasks') {
    return json({ ok: true, ...(await listTasks(db, { status: q('status'), assignee: q('assignee'), limit: q('limit') })) });
  }
  // GET /api/tasks/{id}[/events|/resume]
  if (segs.length >= 3 && segs[1] === 'tasks') {
    const task_id = decodeURIComponent(segs[2]);
    if (segs.length === 3) {
      const task = await getTask(db, task_id);
      if (!task) return json({ ok: false, code: 'NOT_FOUND', message: `task ${task_id} not found` }, 404);
      return json({ ok: true, task });
    }
    if (segs.length === 4 && segs[3] === 'events') {
      const data = await getTaskEvents(db, task_id, { after_seq: q('after_seq'), limit: q('limit') });
      if (!data) return json({ ok: false, code: 'NOT_FOUND', message: `task ${task_id} not found` }, 404);
      return json({ ok: true, ...data });
    }
    if (segs.length === 4 && segs[3] === 'resume') {
      const resume = await getResume(db, task_id);
      if (!resume) return json({ ok: false, code: 'NOT_FOUND', message: `task ${task_id} not found` }, 404);
      return json({ ok: true, resume });
    }
  }
  // GET /api/activity
  if (segs.length === 2 && segs[1] === 'activity') {
    return json({ ok: true, ...(await getActivity(db, { limit: q('limit') })) });
  }
  // GET /api/decisions
  if (segs.length === 2 && segs[1] === 'decisions') {
    return json({ ok: true, ...(await listDecisions(db, { state: q('state') })) });
  }
  // GET /api/agents
  if (segs.length === 2 && segs[1] === 'agents') {
    return json({ ok: true, ...(await listAgents(db)) });
  }

  return json({ ok: false, code: 'NOT_FOUND', message: `no route GET ${url.pathname}` }, 404);
}

// Never leak internal principal fields to clients.
function sanitizePrincipal(p) {
  if (p.kind === 'david') return { kind: 'david' };
  return { kind: 'agent', agent_id: p.agent_id, role: p.role };
}
