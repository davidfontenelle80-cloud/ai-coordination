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

  it('unknown routes are 404 with a stable error body', async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    const r = await get('/api/nope', { cookie: `hub_session=${sessionId}` });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'NOT_FOUND');
  });
});

describe('task 009 command/query API', () => {
  let httpKeyTick = 0;
  // Every mutating command requires a client-supplied idempotency key.
  const post = (body, token) =>
    handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idempotency_key: `http-key-${httpKeyTick++}`, ...body }),
    }), env);

  async function tokenFor(agent_id, role) {
    const { issueAgentToken } = await import('../src/auth.mjs');
    const { token } = await issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p),
        batch: (stmts) => db.batch(stmts) },
      { agent_id, display_name: agent_id, role }, { by: 'david' });
    return token;
  }

  it('unauthenticated command and query calls are 401', async () => {
    const c = await post({ command: 'createTask', title: 'T', goal: 'G' });
    assert.equal(c.status, 401);
    assert.equal((await c.json()).code, 'AUTH_REQUIRED');
    const q = await get('/api/tasks');
    assert.equal(q.status, 401);
  });

  it('full task lifecycle over HTTP', async () => {
    const mateoTok = await tokenFor('mateo', 'mateo');
    const gptTok = await tokenFor('chatgpt', 'agent');

    // Ordinary agents cannot create tasks.
    const denied = await post({ command: 'createTask', title: 'T', goal: 'G' }, gptTok);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'FORBIDDEN');

    const created = await post({ command: 'createTask', task_id: 'http_task1', title: 'HTTP task', goal: 'Prove the API' }, mateoTok);
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.task_id, 'http_task1');

    assert.equal((await post({ command: 'claimTask', task_id: 'http_task1' }, gptTok)).status, 200);
    assert.equal((await post({ command: 'startTask', task_id: 'http_task1' }, gptTok)).status, 200);
    const sub = await post({ command: 'submitResult', task_id: 'http_task1', summary: 'Done via HTTP' }, gptTok);
    assert.equal(sub.status, 200);
    const rev = await post({ command: 'recordReview', task_id: 'http_task1', outcome: 'accepted' }, mateoTok);
    assert.equal(rev.status, 200);

    // Query: single task.
    const one = await get('/api/tasks/http_task1', { authorization: `Bearer ${gptTok}` });
    assert.equal(one.status, 200);
    assert.equal((await one.json()).task.status, 'completed');

    // Query: task list with filter.
    const list = await get('/api/tasks?status=completed', { authorization: `Bearer ${gptTok}` });
    assert.equal((await list.json()).tasks.length, 1);

    // Query: events after a seq cursor.
    const evs = await get('/api/tasks/http_task1/events?after_seq=3', { authorization: `Bearer ${gptTok}` });
    const evsBody = await evs.json();
    assert.ok(evsBody.events.length >= 2);
    assert.ok(evsBody.events.every((e) => e.seq > 3));
    assert.equal(evsBody.events[0].payload.summary, 'Done via HTTP');

    // Query: resume packet.
    const resume = await get('/api/tasks/http_task1/resume', { authorization: `Bearer ${gptTok}` });
    const resumeBody = await resume.json();
    assert.equal(resumeBody.resume.status, 'completed');
    assert.equal(resumeBody.resume.latest_result.summary, 'Done via HTTP');
    assert.equal(resumeBody.resume.latest_review.outcome, 'accepted');

    // Query: unknown task is 404.
    const missing = await get('/api/tasks/nope', { authorization: `Bearer ${gptTok}` });
    assert.equal(missing.status, 404);
  });

  it('version conflicts surface as 409 with the live version', async () => {
    const mateoTok = await tokenFor('mateo', 'mateo');
    const gptTok = await tokenFor('chatgpt', 'agent');
    await post({ command: 'createTask', task_id: 'http_task2', title: 'T', goal: 'G' }, mateoTok);
    await post({ command: 'claimTask', task_id: 'http_task2' }, gptTok);
    const r = await post({ command: 'startTask', task_id: 'http_task2', expected_task_version: 1 }, gptTok);
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, 'VERSION_CONFLICT');
    assert.equal(body.current_task_version, 2);
    assert.equal(body.retryable, true);
  });

  it('decisions, agents, and activity queries', async () => {
    const mateoTok = await tokenFor('mateo', 'mateo');
    const gptTok = await tokenFor('chatgpt', 'agent');
    const authz = { authorization: `Bearer ${gptTok}` };

    await post({ command: 'createTask', task_id: 'http_task3', title: 'T', goal: 'G' }, mateoTok);
    await post({ command: 'claimTask', task_id: 'http_task3' }, gptTok);
    await post({ command: 'requestDecision', task_id: 'http_task3', question: 'Which way?', options: ['a', 'b'] }, gptTok);
    await post({
      command: 'setAgentStatus', context_health: 'normal', work_state: 'working', current_task_id: 'http_task3',
    }, gptTok);

    const decs = await get('/api/decisions?state=requested', authz);
    assert.equal((await decs.json()).decisions.length, 1);

    const agents = await get('/api/agents', authz);
    const agentsBody = await agents.json();
    assert.equal(agentsBody.agents.find((a) => a.agent_id === 'chatgpt').work_state, 'working');

    const act = await get('/api/activity?limit=5', authz);
    assert.ok((await act.json()).events.length >= 1);
  });

  it('unexpected errors are 500 INTERNAL_ERROR, never auth failures', async () => {
    const mateoTok = await tokenFor('mateo', 'mateo');
    // A malformed percent-encoding makes decodeURIComponent throw URIError —
    // previously this surfaced as a 401-style auth error, which is
    // misleading for debugging. (ChatGPT 009 review.)
    const r = await handler.fetch(new Request('https://hub.example.com/api/tasks/%E0%A4%A', {
      headers: { authorization: `Bearer ${mateoTok}` },
    }), env);
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.code, 'INTERNAL_ERROR');
  });

  it('malformed JSON body is a 400 with a stable code', async () => {
    const mateoTok = await tokenFor('mateo', 'mateo');
    const r = await handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST',
      headers: { authorization: `Bearer ${mateoTok}`, 'content-type': 'application/json' },
      body: '{not json',
    }), env);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'VALIDATION_FAILED');
  });
});
