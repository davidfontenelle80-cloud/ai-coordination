// oauth.test.mjs — task 020 OAuth 2.1 issuance ceremony for the MCP server.
// Drives the real Worker fetch handler end to end (metadata -> register ->
// authorize -> David's GitHub login -> consent with agent_id -> PKCE
// exchange -> /mcp) against a fake D1 backed by node:sqlite. GitHub is
// stubbed via globalThis.fetch, as in routes.test.mjs. Dependency-free.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import handler from '../src/index.mjs';
import { randomBase64Url } from '../src/auth.mjs';
import { isChatGptCallback, isLoopbackRedirect } from '../src/oauth.mjs';

const SCHEMA = ['0001_schema.sql', '0002_auth.sql', '0003_mcp_oauth.sql']
  .map((f) => readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8')).join('\n');

const ORIGIN = 'https://hub.example.com';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const DAVID_ID = 12345678;
const ENV_BASE = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  DAVID_GITHUB_ID: String(DAVID_ID),
  OAUTH_REDIRECT_URI: `${ORIGIN}/auth/github/callback`,
};

function fakeD1(db) {
  const prepare = (sql) => ({
    bind: (...params) => ({
      _sql: sql,
      _params: params,
      first: async () => db.queryOne(sql, params) ?? null,
      all: async () => ({ results: db.queryAll(sql, params) }),
    }),
  });
  return {
    prepare,
    batch: async (boundStmts) => {
      db.batch(boundStmts.map((s) => ({ sql: s._sql, params: s._params })));
    },
  };
}

let db;
let env;
let realFetch;
let ip; // per-test client IP so in-memory rate-limit buckets never collide
let ipTick = 0;
beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  env = { ...ENV_BASE, DB: fakeD1(db) };
  realFetch = globalThis.fetch;
  ip = `10.20.${Math.floor(ipTick / 250)}.${ipTick++ % 250}`;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

const req = (path, { method = 'GET', headers = {}, body } = {}) =>
  handler.fetch(new Request(`${ORIGIN}${path}`, {
    method, headers: { 'cf-connecting-ip': ip, ...headers }, body, redirect: 'manual',
  }), env);

const form = (obj) => new URLSearchParams(obj).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function stubGitHub(userId) {
  globalThis.fetch = async (url) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return { json: async () => ({ access_token: 'gho_test' }) };
    }
    if (url === 'https://api.github.com/user') return { json: async () => ({ id: userId }) };
    throw new Error('unexpected fetch: ' + url);
  };
}

async function pkcePair() {
  const verifier = randomBase64Url(32); // 43 chars
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

async function registerClient(redirect_uris = [CLAUDE_CB], client_name = 'Claude') {
  const r = await req('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris, client_name, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  return r;
}

function authorizeUrl(client_id, challenge, extra = {}) {
  const p = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: CLAUDE_CB,
    code_challenge: challenge, code_challenge_method: 'S256',
    state: 'client-state-123', resource: `${ORIGIN}/mcp`, ...extra,
  });
  return `/oauth/authorize?${p}`;
}

const hidden = (html, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];

// David signs in with GitHub from the authorize redirect and lands on the
// consent screen. Returns { cookie, html, request, csrf }.
async function reachConsent(client_id, challenge, extra) {
  const start = await req(authorizeUrl(client_id, challenge, extra));
  assert.equal(start.status, 302);
  const gh = new URL(start.headers.get('location'));
  assert.equal(gh.origin + gh.pathname, 'https://github.com/login/oauth/authorize');
  stubGitHub(DAVID_ID);
  const cb = await req(`/auth/github/callback?code=gh-code&state=${gh.searchParams.get('state')}`);
  assert.equal(cb.status, 302, 'linked login returns to consent');
  const cookie = /^hub_session=[^;]+/.exec(cb.headers.get('set-cookie'))[0];
  const resume = new URL(cb.headers.get('location'));
  assert.equal(resume.pathname, '/oauth/authorize');
  const consent = await req(resume.pathname + resume.search, { headers: { cookie } });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  return { cookie, html, request: hidden(html, 'request'), csrf: hidden(html, 'csrf') };
}

function submitConsent({ cookie, request, csrf }, fields) {
  return req('/oauth/authorize', {
    method: 'POST', headers: { ...FORM, ...(cookie ? { cookie } : {}) },
    body: form({ request, csrf, ...fields }),
  });
}

// Full ceremony up to the redirect back to Claude. Returns code + context.
async function approve(agent_id = 'claude', client_name = 'Claude') {
  const reg = await registerClient([CLAUDE_CB], client_name);
  const { client_id } = await reg.json();
  const { verifier, challenge } = await pkcePair();
  const consent = await reachConsent(client_id, challenge);
  const r = await submitConsent(consent, { action: 'approve', agent_id });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get('location'));
  assert.equal(back.origin + back.pathname, CLAUDE_CB);
  assert.equal(back.searchParams.get('state'), 'client-state-123');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  return { client_id, verifier, code: back.searchParams.get('code'), consent };
}

function tokenRequest(fields, headers = {}) {
  return req('/oauth/token', { method: 'POST', headers: { ...FORM, ...headers }, body: form(fields) });
}

async function exchange({ client_id, verifier, code }, extra = {}) {
  return tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CB,
    client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp`, ...extra,
  });
}

let rpcId = 0;
async function mcp(token, method, params) {
  const r = await req('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
async function tool(token, name, args) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result.structuredContent;
}
let keyTick = 0;
const idem = () => `oauth-key-${keyTick++}`;

describe('task 020 OAuth: discovery', () => {
  it('serves RFC 9728 protected-resource metadata at both well-known paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await req(path);
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.equal(m.resource, `${ORIGIN}/mcp`);
      assert.deepEqual(m.authorization_servers, [ORIGIN]);
      assert.deepEqual(m.bearer_methods_supported, ['header']);
    }
  });

  it('serves RFC 8414 authorization-server metadata (S256 only, public clients)', async () => {
    const m = await (await req('/.well-known/oauth-authorization-server')).json();
    assert.equal(m.issuer, ORIGIN);
    assert.equal(m.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(m.token_endpoint, `${ORIGIN}/oauth/token`);
    assert.equal(m.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(m.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none']);
  });

  it('/mcp 401s point at the resource metadata; the body is unchanged from 019', async () => {
    const r = await mcp(null, 'tools/list');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' });
    assert.equal(r.headers.get('www-authenticate'),
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await mcp('tok_nope.nope', 'tools/list');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'AUTH_BAD_TOKEN');
    assert.match(bad.headers.get('www-authenticate'), /resource_metadata=/);
  });
});

describe('task 020 OAuth: client registration', () => {
  it('registers a public client for Claude\'s callback', async () => {
    const r = await registerClient();
    assert.equal(r.status, 201);
    const c = await r.json();
    assert.match(c.client_id, /^mcpc_/);
    assert.equal(c.token_endpoint_auth_method, 'none');
    assert.deepEqual(c.redirect_uris, [CLAUDE_CB]);
    assert.equal(c.client_secret, undefined);
  });

  it('refuses redirect URIs outside the allowlist', async () => {
    // Note: http://localhost loopback callbacks are intentionally allowed now
    // (RFC 8252 native desktop clients) — see the loopback describe block.
    for (const uris of [['https://evil.example/cb'], ['http://example.com:3118/callback'], [], 'x']) {
      const r = await registerClient(uris);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_redirect_uri');
    }
    const ok = await registerClient(['https://claude.com/api/mcp/auth_callback']);
    assert.equal(ok.status, 201);
  });
});

describe('ChatGPT OAuth: per-connection redirect callbacks', () => {
  const good = [
    'https://chatgpt.com/connector/oauth/abc123',
    'https://chatgpt.com/connector/oauth/AbC-123_xYz',
    `https://chatgpt.com/connector/oauth/${'a'.repeat(200)}`,
  ];
  const bad = [
    'https://chatgpt.com/connector/oauth/', // empty id segment
    'https://chatgpt.com/connector/oauth/a/b', // two segments
    'https://chatgpt.com/connector/oauth/a b', // space
    'https://chatgpt.com/connector/oauth/abc?x=1', // query
    'https://chatgpt.com/connector/oauth/abc#frag', // fragment
    'https://chatgpt.com:8443/connector/oauth/abc', // non-default port
    'https://user@chatgpt.com/connector/oauth/abc', // userinfo
    'http://chatgpt.com/connector/oauth/abc', // not https
    'https://chatgpt.com.evil.example/connector/oauth/abc', // lookalike host
    'https://evilchatgpt.com/connector/oauth/abc', // lookalike host
    'https://chatgpt.com/other/oauth/abc', // wrong path prefix
    'https://chatgpt.com/connector/oauth', // missing id
    `https://chatgpt.com/connector/oauth/${'a'.repeat(201)}`, // id too long
    'https://chatgpt.com/connector/oauth/%2e%2e', // encoded traversal
    'not a url',
    '',
  ];

  it('predicate accepts ChatGPT callbacks and rejects lookalikes', () => {
    for (const u of good) assert.equal(isChatGptCallback(u), true, u);
    for (const u of bad) assert.equal(isChatGptCallback(u), false, u);
  });

  it('registers a public client for a ChatGPT per-connection callback', async () => {
    const cb = 'https://chatgpt.com/connector/oauth/test-callback-id-1';
    const r = await registerClient([cb], 'ChatGPT');
    assert.equal(r.status, 201);
    const c = await r.json();
    assert.match(c.client_id, /^mcpc_/);
    assert.deepEqual(c.redirect_uris, [cb]);
  });

  it('registers a client for the legacy fixed ChatGPT callback', async () => {
    const r = await registerClient(['https://chatgpt.com/connector_platform_oauth_redirect'], 'ChatGPT');
    assert.equal(r.status, 201);
  });

  it('still refuses non-ChatGPT, non-Claude, non-loopback callbacks', async () => {
    for (const u of ['https://evil.example/cb', 'https://chatgpt.com/connector/oauth/a/b', 'http://example.com:54321/callback']) {
      const r = await registerClient([u]);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_redirect_uri');
    }
  });
});

describe('ChatGPT desktop OAuth: RFC 8252 loopback redirects', () => {
  const good = [
    'http://localhost:54321/callback', // the desktop app's ephemeral-port pattern
    'http://localhost/callback', // no port
    'http://localhost:1/', // bare root, any port
    'http://127.0.0.1:9876/callback/abc', // IPv4 loopback
    'http://[::1]:1234/callback', // IPv6 loopback
    `http://localhost:54321/${'a'.repeat(190)}`, // bounded long path
  ];
  const bad = [
    'https://localhost:54321/callback', // loopback must be http, not https
    'http://example.com:54321/callback', // not a loopback host
    'http://localhost.evil.example/callback', // lookalike host
    'http://evil-localhost.example/callback', // lookalike host
    'http://127.0.0.2:1/callback', // not the loopback address
    'http://localhost:54321/callback?x=1', // query
    'http://localhost:54321/callback#frag', // fragment
    'http://user@localhost:54321/callback', // userinfo
    `http://localhost:54321/${'a'.repeat(201)}`, // path too long
    'not a url',
    '',
  ];

  it('predicate accepts loopback redirects and rejects lookalikes', () => {
    for (const u of good) assert.equal(isLoopbackRedirect(u), true, u);
    for (const u of bad) assert.equal(isLoopbackRedirect(u), false, u);
  });

  it('registers a public client for a desktop loopback callback', async () => {
    const cb = 'http://localhost:54321/callback';
    const r = await registerClient([cb], 'ChatGPT desktop');
    assert.equal(r.status, 201);
    const c = await r.json();
    assert.match(c.client_id, /^mcpc_/);
    assert.deepEqual(c.redirect_uris, [cb]);
  });
});

describe('ChatGPT discovery: path-suffixed authorization-server metadata', () => {
  it('serves RFC 8414 metadata at /.well-known/oauth-authorization-server/mcp', async () => {
    const r = await req('/.well-known/oauth-authorization-server/mcp');
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.issuer, ORIGIN);
    assert.equal(m.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
  });
});

describe('task 020 OAuth: full round trip', () => {
  it('authorize -> GitHub (David) -> consent -> PKCE exchange -> authenticated /mcp tools/call', async () => {
    const flow = await approve('claude');
    const tr = await exchange(flow);
    assert.equal(tr.status, 200);
    assert.equal(tr.headers.get('cache-control'), 'no-store');
    const tok = await tr.json();
    assert.equal(tok.token_type, 'Bearer');
    assert.match(tok.access_token, /^tok_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/); // normal hub agent token
    assert.match(tok.refresh_token, /^hrt_/);

    const init = await mcp(tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'ai-hub');
    const act = await tool(tok.access_token, 'get_activity', {});
    assert.equal(act.ok, true);

    // Stored like any dashboard-issued token: hash only, visible to David.
    const row = db.queryOne('SELECT agent_id, created_by, secret_hash FROM agent_tokens WHERE token_id = ?',
      [tok.access_token.split('.')[0]]);
    assert.equal(row.agent_id, 'claude');
    assert.equal(row.created_by, 'david-oauth');
    assert.notEqual(row.secret_hash, tok.access_token.split('.')[1]);
    // Nothing plaintext at rest in the OAuth tables.
    const dump = JSON.stringify([
      db.queryAll('SELECT * FROM oauth_codes'), db.queryAll('SELECT * FROM oauth_refresh_tokens')]);
    assert.ok(!dump.includes(flow.code));
    assert.ok(!dump.includes(tok.refresh_token));
    assert.ok(!dump.includes(tok.access_token.split('.')[1]));
  });

  it('the consent page names the client, shows the redirect host, and escapes input', async () => {
    const { client_id } = await (await registerClient([CLAUDE_CB], '<script>x</script>')).json();
    const { challenge } = await pkcePair();
    const { html } = await reachConsent(client_id, challenge);
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
    assert.ok(!html.includes('<script>x'));
    assert.ok(html.includes('claude.ai'));
    assert.match(html, /name="agent_id"[^>]*required/);
  });

  it('a David who is already signed in goes straight to consent', async () => {
    const first = await approve('claude');
    const { client_id } = first;
    const { challenge } = await pkcePair();
    const r = await req(authorizeUrl(client_id, challenge), { headers: { cookie: first.consent.cookie } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Approve MCP access/);
  });
});

describe('task 020 OAuth: token bound to the agent_id David approves', () => {
  it('the token acts as exactly the approved agent_id and cannot act as another', async () => {
    const flow = await approve('claude');
    // A client-supplied agent_id at the token endpoint is ignored.
    const tok = await (await exchange(flow, { agent_id: 'chatgpt' })).json();
    const t = tok.access_token;

    const me = await req('/auth/me', { headers: { authorization: `Bearer ${t}` } });
    assert.deepEqual((await me.json()).principal, { kind: 'agent', agent_id: 'claude', role: 'agent' });

    // Ordinary-agent rules: cannot create tasks, cannot resolve decisions.
    assert.equal((await tool(t, 'create_task', { title: 'T', goal: 'G', idempotency_key: idem() })).code, 'FORBIDDEN');
    assert.equal((await tool(t, 'resolve_decision', { decision_id: 'd', resolution: 'r', idempotency_key: idem() })).code,
      'FORBIDDEN');

    // Status reported "as chatgpt" is recorded as claude.
    const st = await tool(t, 'set_agent_status', {
      agent_id: 'chatgpt', context_health: 'normal', work_state: 'idle', current_task_id: null, idempotency_key: idem(),
    });
    assert.equal(st.ok, true);
    const agents = (await tool(t, 'list_agents', {})).agents.map((a) => a.agent_id);
    assert.deepEqual(agents, ['claude']);

    // Claiming on behalf of another agent is refused; messages are attributed to claude.
    const mateo = await (await import('../src/auth.mjs')).issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p), batch: (x) => db.batch(x) },
      { agent_id: 'mateo', display_name: 'Mateo', role: 'mateo' }, { by: 'david' });
    assert.equal((await tool(mateo.token, 'create_task',
      { task_id: 'bind1', title: 'T', goal: 'G', idempotency_key: idem() })).ok, true);
    const claim = await tool(t, 'claim_task', { task_id: 'bind1', assignee: 'chatgpt', idempotency_key: idem() });
    assert.equal(claim.code, 'FORBIDDEN');
    assert.equal((await tool(t, 'post_message',
      { task_id: 'bind1', body: 'hi', actor_id: 'chatgpt', idempotency_key: idem() })).ok, true);
    const msg = (await tool(t, 'get_activity', {})).events.find((e) => e.event_type === 'message.posted');
    assert.equal(msg.actor_id, 'claude');

    // A refreshed token stays bound to claude.
    const r2 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token,
      client_id: flow.client_id, agent_id: 'chatgpt' })).json();
    const me2 = await req('/auth/me', { headers: { authorization: `Bearer ${r2.access_token}` } });
    assert.equal((await me2.json()).principal.agent_id, 'claude');
  });

  it('two approvals for different agent_ids yield tokens bound to each', async () => {
    const a = await (await exchange(await approve('claude'))).json();
    const b = await (await exchange(await approve('gemini'))).json();
    const who = async (t) =>
      (await (await req('/auth/me', { headers: { authorization: `Bearer ${t}` } })).json()).principal.agent_id;
    assert.equal(await who(a.access_token), 'claude');
    assert.equal(await who(b.access_token), 'gemini');
  });

  it('David must name the agent explicitly; Mateo-role and malformed ids are refused', async () => {
    const { issueAgentToken } = await import('../src/auth.mjs');
    await issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p), batch: (x) => db.batch(x) },
      { agent_id: 'mateo', display_name: 'Mateo', role: 'mateo' }, { by: 'david' });
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    let consent = await reachConsent(client_id, challenge);
    for (const agent_id of ['', 'mateo', 'Claude!', 'a'.repeat(65)]) {
      const r = await submitConsent(consent, { action: 'approve', agent_id });
      assert.equal(r.status, 200, `agent_id ${JSON.stringify(agent_id)} must not issue a code`);
      const html = await r.text();
      assert.match(html, /class="box err"/);
      consent = { ...consent, request: hidden(html, 'request'), csrf: hidden(html, 'csrf') };
    }
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM oauth_codes').c, 0);
    // The re-rendered form still works once a valid id is given.
    const ok = await submitConsent(consent, { action: 'approve', agent_id: 'claude' });
    assert.equal(ok.status, 302);
  });
});

describe('task 020 OAuth: failure cases', () => {
  it('non-David GitHub user is refused and never reaches consent', async () => {
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    const start = await req(authorizeUrl(client_id, challenge));
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    stubGitHub(99999999);
    const cb = await req(`/auth/github/callback?code=c&state=${state}`);
    assert.equal(cb.status, 403);
    assert.equal((await cb.json()).code, 'AUTH_NOT_ALLOWLISTED');
    assert.equal(cb.headers.get('set-cookie'), null);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM oauth_codes').c, 0);
  });

  it('consent needs David\'s session and the matching CSRF token', async () => {
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    const consent = await reachConsent(client_id, challenge);
    // No session.
    assert.equal((await submitConsent({ ...consent, cookie: null }, { action: 'approve', agent_id: 'claude' })).status, 403);
    // Wrong CSRF.
    assert.equal((await submitConsent({ ...consent, csrf: 'forged' }, { action: 'approve', agent_id: 'claude' })).status, 403);
    // An agent bearer is not David.
    const { issueAgentToken } = await import('../src/auth.mjs');
    const agent = await issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p), batch: (x) => db.batch(x) },
      { agent_id: 'chatgpt', display_name: 'c', role: 'agent' }, { by: 'david' });
    const asAgent = await req('/oauth/authorize', {
      method: 'POST', headers: { ...FORM, authorization: `Bearer ${agent.token}` },
      body: form({ request: consent.request, csrf: consent.csrf, action: 'approve', agent_id: 'claude' }),
    });
    assert.equal(asAgent.status, 403);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM oauth_codes').c, 0);
    // The genuine form still works, once.
    assert.equal((await submitConsent(consent, { action: 'approve', agent_id: 'claude' })).status, 302);
    assert.equal((await submitConsent(consent, { action: 'approve', agent_id: 'claude' })).status, 400);
  });

  it('Deny redirects with access_denied and issues nothing', async () => {
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    const consent = await reachConsent(client_id, challenge);
    const r = await submitConsent(consent, { action: 'deny' });
    assert.equal(r.status, 302);
    const back = new URL(r.headers.get('location'));
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'client-state-123');
    assert.equal(back.searchParams.get('code'), null);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM oauth_codes').c, 0);
  });

  it('bad authorize requests: unknown client / unregistered redirect never redirect; missing PKCE redirects an error', async () => {
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    const unknown = await req(authorizeUrl('mcpc_nope', challenge));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get('location'), null);
    const badRedirect = await req(authorizeUrl(client_id, challenge,
      { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }));
    assert.equal(badRedirect.status, 400);
    assert.equal(badRedirect.headers.get('location'), null);
    for (const extra of [{ code_challenge: '' }, { code_challenge_method: 'plain' }]) {
      const r = await req(authorizeUrl(client_id, challenge, extra));
      assert.equal(r.status, 302);
      assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'invalid_request');
    }
    const wrongResource = await req(authorizeUrl(client_id, challenge, { resource: 'https://other.example/mcp' }));
    assert.equal(new URL(wrongResource.headers.get('location')).searchParams.get('error'), 'invalid_target');
  });

  it('PKCE failure is invalid_grant and burns the code', async () => {
    const flow = await approve();
    const wrong = await exchange({ ...flow, verifier: randomBase64Url(32) });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'invalid_grant');
    const retry = await exchange(flow);
    assert.equal((await retry.json()).error, 'invalid_grant');
    assert.equal(db.queryOne("SELECT COUNT(*) c FROM agent_tokens WHERE created_by = 'david-oauth'").c, 0);
  });

  it('code replay is refused and revokes the tokens the first exchange issued', async () => {
    const flow = await approve();
    const first = await (await exchange(flow)).json();
    assert.equal((await tool(first.access_token, 'get_stats', {})).ok, true);
    const replay = await exchange(flow);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
    const after = await mcp(first.access_token, 'tools/list');
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'AUTH_TOKEN_REVOKED');
    const rf = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: flow.client_id });
    assert.equal((await rf.json()).error, 'invalid_grant');
  });

  it('an expired code is invalid_grant', async () => {
    const flow = await approve();
    db.batch([{ sql: 'UPDATE oauth_codes SET expires_at = ?', params: [Date.now() - 1] }]);
    const r = await exchange(flow);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
  });

  it('a code only works for its own client and redirect_uri', async () => {
    const flow = await approve();
    const other = await (await registerClient()).json();
    assert.equal((await (await exchange({ ...flow, client_id: other.client_id })).json()).error, 'invalid_grant');
    const flow2 = await approve();
    const r = await exchange(flow2, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' });
    assert.equal((await r.json()).error, 'invalid_grant');
    const unknownClient = await exchange({ ...flow2, client_id: 'mcpc_nope' });
    assert.equal(unknownClient.status, 401);
    assert.equal((await unknownClient.json()).error, 'invalid_client');
  });

  it('an expired consent request cannot be approved', async () => {
    const { client_id } = await (await registerClient()).json();
    const { challenge } = await pkcePair();
    const consent = await reachConsent(client_id, challenge);
    db.batch([{ sql: 'UPDATE oauth_authorize_requests SET expires_at = ?', params: [Date.now() - 1] }]);
    const r = await submitConsent(consent, { action: 'approve', agent_id: 'claude' });
    assert.equal(r.status, 400);
  });

  it('unsupported grant types are refused', async () => {
    const { client_id } = await (await registerClient()).json();
    const r = await tokenRequest({ grant_type: 'client_credentials', client_id });
    assert.equal((await r.json()).error, 'unsupported_grant_type');
  });

  it('failed token requests share the brute-force limiter (429 after 20)', async () => {
    const { client_id } = await (await registerClient()).json();
    let last;
    for (let i = 0; i < 21; i++) {
      last = await tokenRequest({ grant_type: 'authorization_code', client_id, code: 'nope',
        code_verifier: randomBase64Url(32), redirect_uri: CLAUDE_CB });
    }
    assert.equal(last.status, 429);
    // The same bucket also throttles bad bearers on /mcp from that IP.
    const r = await mcp('tok_nope.nope', 'tools/list');
    assert.equal(r.status, 429);
  });
});

describe('task 020 OAuth: refresh rotation', () => {
  it('rotates: new access + refresh token, old access token revoked, same agent', async () => {
    const flow = await approve();
    const t1 = await (await exchange(flow)).json();
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: flow.client_id });
    assert.equal(r.status, 200);
    const t2 = await r.json();
    assert.notEqual(t2.access_token, t1.access_token);
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.equal((await mcp(t1.access_token, 'tools/list')).body.code, 'AUTH_TOKEN_REVOKED');
    assert.equal((await mcp(t2.access_token, 'tools/list')).status, 200);
    // And again from the new refresh token.
    const t3 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t2.refresh_token,
      client_id: flow.client_id })).json();
    assert.equal((await mcp(t3.access_token, 'tools/list')).status, 200);
  });

  it('reuse of a rotated refresh token revokes the whole family', async () => {
    const flow = await approve();
    const t1 = await (await exchange(flow)).json();
    const t2 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token,
      client_id: flow.client_id })).json();
    const reuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: flow.client_id });
    assert.equal(reuse.status, 400);
    assert.equal((await reuse.json()).error, 'invalid_grant');
    assert.equal((await mcp(t2.access_token, 'tools/list')).body.code, 'AUTH_TOKEN_REVOKED');
    const t2refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t2.refresh_token,
      client_id: flow.client_id });
    assert.equal((await t2refresh.json()).error, 'invalid_grant');
  });

  it('a token David revokes from the dashboard cannot be refreshed back to life', async () => {
    const flow = await approve();
    const t1 = await (await exchange(flow)).json();
    const token_id = t1.access_token.split('.')[0];
    const rev = await req('/auth/agents/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: flow.consent.cookie },
      body: JSON.stringify({ token_id }),
    });
    assert.equal(rev.status, 200);
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: flow.client_id });
    assert.equal((await r.json()).error, 'invalid_grant');
    assert.equal(db.queryOne(
      "SELECT COUNT(*) c FROM agent_tokens WHERE created_by = 'david-oauth' AND revoked_at IS NULL").c, 0);
  });

  it('a refresh token only works for the client it was issued to', async () => {
    const flow = await approve();
    const t1 = await (await exchange(flow)).json();
    const other = await (await registerClient()).json();
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: other.client_id });
    assert.equal((await r.json()).error, 'invalid_grant');
    assert.equal((await mcp(t1.access_token, 'tools/list')).status, 200);
  });
});

describe('task 020 OAuth: existing auth untouched', () => {
  it('/mcp still refuses David\'s session cookie', async () => {
    const flow = await approve();
    const r = await req('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: flow.consent.cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(r.status, 401);
  });

  it('a plain dashboard GitHub login still returns the JSON body (no OAuth redirect)', async () => {
    const login = await req('/auth/github/login');
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    stubGitHub(DAVID_ID);
    const cb = await req(`/auth/github/callback?code=c&state=${state}`);
    assert.equal(cb.status, 200);
    assert.deepEqual(await cb.json(), { ok: true, github_user_id: DAVID_ID });
  });
});
