// index.mjs — Worker entry point.
//
// Task 008: auth routes are live. Domain command handlers land in task 009;
// anything else still returns 501.
//
// Routes:
//   GET  /auth/github/login     -> 302 to GitHub authorize
//   GET  /auth/github/callback  -> validate state, exchange code, set session
//   POST /auth/logout           -> revoke session, clear cookie
//   GET  /auth/me               -> current principal (or 401)
//   POST /auth/agents           -> issue agent bearer token (David/Mateo only;
//                                 plaintext token shown ONCE in the response)
//
// Env: DB (D1), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (secrets),
//      DAVID_GITHUB_ID (numeric), OAUTH_REDIRECT_URI.

import { d1Db } from './d1-db.mjs';
import {
  authenticate, authorize, issueAgentToken,
  beginGitHubLogin, completeGitHubLogin, logout, err,
} from './auth.mjs';

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

      // -- Everything else: command handlers land in task 009 ----------
      return json(
        { ok: false, code: 'NOT_IMPLEMENTED', message: 'command handlers land in task 009' },
        501,
      );
    } catch (e) {
      return authError(e);
    }
  },
};

// Never leak internal principal fields to clients.
function sanitizePrincipal(p) {
  if (p.kind === 'david') return { kind: 'david' };
  return { kind: 'agent', agent_id: p.agent_id, role: p.role };
}
