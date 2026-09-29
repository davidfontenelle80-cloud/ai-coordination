// routes.test.mjs — HTTP-level tests for the task-008 auth routes.
// Exercises the real Worker fetch handler against a fake D1 binding
// backed by node:sqlite. GitHub network calls are stubbed by replacing
// globalThis.fetch for the callback test.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import handler from '../src/index.mjs';

const SCHEMA = readFileSync(new URL('../../db/migrations/0001_schema.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../../db/migrations/0002_auth.sql', import.meta.url), 'utf8');

const ENV_BASE = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  DAVID_GITHUB_ID: '12345678',
  OAUTH_REDIRECT_URI: 'https://hub.example.com/auth/github/callback',
};

// Fake D1 binding: prepare/bind/first/all/batch backed by node:sqlite.
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
beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  env = { ...ENV_BASE, DB: fakeD1(db) };
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

const get = (path, headers = {}) =>
  handler.fetch(new Request(`https://hub.example.com${path}`, { headers }), env);

function stubGitHub(userId) {
  globalThis.fetch = async (url) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return { json: async () => ({ access_token: 'gho_test' }) };
    }
    if (url === 'https://api.github.com/user') {
      return { json: async () => ({ id: userId }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

async function loginAsDavid() {
  stubGitHub(12345678);
  const login = await get('/auth/github/login');
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cb = await get(`/auth/github/callback?code=code123&state=${state}`);
  assert.equal(cb.status, 200);
  return cb.headers.get('set-cookie');
}

describe('auth routes', () => {
  it('GET /auth/github/login redirects to GitHub with a persisted state', async () => {
    const r = await get('/auth/github/login');
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'test-client-id');
    assert.ok(loc.searchParams.get('state'));
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM oauth_states').c, 1);
  });

  it('callback creates a session; /auth/me returns the david principal', async () => {
    const setCookie = await loginAsDavid();
    assert.match(setCookie, /^hub_session=/);
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];

    const me = await get('/auth/me', { cookie: `hub_session=${sessionId}` });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { ok: true, principal: { kind: 'david' } });
  });

  it('callback rejects a non-allowlisted GitHub user with 403', async () => {
    stubGitHub(99999999);
    const login = await get('/auth/github/login');
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const cb = await get(`/auth/github/callback?code=c&state=${state}`);
    assert.equal(cb.status, 403);
    const body = await cb.json();
    assert.equal(body.code, 'AUTH_NOT_ALLOWLISTED');
  });

  it('/auth/me without credential is 401', async () => {
    const r = await get('/auth/me');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'AUTH_REQUIRED');
  });

  it('David can issue an agent token; it authenticates exactly once shown', async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];

    const issue = await handler.fetch(new Request('https://hub.example.com/auth/agents', {
      method: 'POST',
      headers: { cookie: `hub_session=${sessionId}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'chatgpt', display_name: 'ChatGPT', role: 'agent' }),
    }), env);
    assert.equal(issue.status, 201);
    const { token_id, token } = await issue.json();
    assert.match(token_id, /^tok_/);
    assert.ok(token.includes('.'));

    // The issued token authenticates.
    const me = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(),
      { ok: true, principal: { kind: 'agent', agent_id: 'chatgpt', role: 'agent' } });
  });

  it('an agent token cannot issue further tokens (403)', async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    const issue = await handler.fetch(new Request('https://hub.example.com/auth/agents', {
      method: 'POST',
      headers: { cookie: `hub_session=${sessionId}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'chatgpt', role: 'agent' }),
    }), env);
    const { token } = await issue.json();

    const again = await handler.fetch(new Request('https://hub.example.com/auth/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'codex', role: 'agent' }),
    }), env);
    assert.equal(again.status, 403);
    assert.equal((await again.json()).code, 'FORBIDDEN');
  });

  it('bad bearer on a protected route is 401', async () => {
    const r = await get('/auth/me', { authorization: 'Bearer tok_nope.bad' });
    assert.equal(r.status, 401);
  });

  it('POST /auth/logout revokes the session', async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    const out = await handler.fetch(new Request('https://hub.example.com/auth/logout', {
      method: 'POST',
      headers: { cookie: `hub_session=${sessionId}` },
    }), env);
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    const me = await get('/auth/me', { cookie: `hub_session=${sessionId}` });
    assert.equal(me.status, 401);
  });

  it('unknown routes still 501 for task 009', async () => {
    const r = await get('/api/tasks');
    assert.equal(r.status, 501);
  });
});
