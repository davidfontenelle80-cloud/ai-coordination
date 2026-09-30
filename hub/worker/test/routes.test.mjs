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

describe('dashboard routes (task 010)', () => {
  const davidCookie = async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    return `hub_session=${sessionId}`;
  };

  async function tokenFor(agent_id, role) {
    const { issueAgentToken } = await import('../src/auth.mjs');
    const { token } = await issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p),
        batch: (stmts) => db.batch(stmts) },
      { agent_id, display_name: agent_id, role }, { by: 'david' });
    return token;
  }

  it('unauthenticated dashboard page redirects to GitHub login', async () => {
    const r = await get('/');
    assert.equal(r.status, 302);
    assert.ok(new URL(r.headers.get('location'), 'https://hub.example.com').pathname
      .startsWith('/auth/github/login'));
    const js = await get('/dashboard/app.js');
    assert.equal(js.status, 302);
  });

  it('David gets the dashboard page and its assets', async () => {
    const cookie = await davidCookie();
    const page = await get('/', { cookie });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('control tower'));
    assert.ok(html.includes('/dashboard/app.js'));
    assert.ok(html.includes('/dashboard/styles.css'));

    const js = await get('/dashboard/app.js', { cookie });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.ok((await js.text()).length > 1000);

    const css = await get('/dashboard/styles.css', { cookie });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /css/);

    const alias = await get('/dashboard', { cookie });
    assert.equal(alias.status, 200);
  });

  it('agents are refused the dashboard with 403', async () => {
    const tok = await tokenFor('chatgpt', 'agent');
    const r = await get('/', { authorization: `Bearer ${tok}` });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'FORBIDDEN');
  });

  it('GET /api/stats returns what-we-control indicators', async () => {
    const cookie = await davidCookie();
    const unauth = await get('/api/stats');
    assert.equal(unauth.status, 401);

    const empty = await get('/api/stats', { cookie });
    assert.equal(empty.status, 200);
    const s0 = (await empty.json()).stats;
    assert.deepEqual(Object.keys(s0).sort(),
      ['agents_count', 'decisions_open', 'events_today', 'events_total', 'tasks_by_status', 'tasks_total'].sort());
    assert.equal(s0.events_total, 0);

    // Create a task over HTTP; the counters move.
    const created = await handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'createTask', title: 'T', goal: 'G', idempotency_key: 'stats-k1' }),
    }), env);
    assert.equal(created.status, 200);
    const s1 = (await (await get('/api/stats', { cookie })).json()).stats;
    assert.equal(s1.events_total, 1);
    assert.equal(s1.events_today, 1);
    assert.equal(s1.tasks_total, 1);
    assert.equal(s1.tasks_by_status.pending, 1);

    // An agent token can read stats too (any authenticated principal).
    const tok = await tokenFor('mateo', 'mateo');
    const asAgent = await get('/api/stats', { authorization: `Bearer ${tok}` });
    assert.equal(asAgent.status, 200);
    assert.equal((await asAgent.json()).stats.events_total, 1);
  });

  it('setPriority works end-to-end over HTTP as David, refused for agents', async () => {
    const cookie = await davidCookie();
    const post = (body, headers = {}) => handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), env);

    const c = await post({ command: 'createTask', title: 'P', goal: 'G', idempotency_key: 'prio-k1' });
    const task_id = (await c.json()).task_id;
    const sp = await post({ command: 'setPriority', task_id, priority: 'urgent', idempotency_key: 'prio-k2' });
    assert.equal(sp.status, 200);
    assert.equal((await sp.json()).event_type, 'task.changed');
    const t = await get(`/api/tasks/${task_id}`, { cookie });
    assert.equal((await t.json()).task.priority, 'urgent');

    const gptTok = await tokenFor('chatgpt', 'agent');
    const denied = await handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST',
      headers: { authorization: `Bearer ${gptTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'setPriority', task_id, priority: 'low', idempotency_key: 'prio-k3' }),
    }), env);
    assert.equal(denied.status, 403);
  });
});

describe('task 015 chat UI + home-screen icons', () => {
  const davidCookie = async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    return `hub_session=${sessionId}`;
  };

  async function tokenFor(agent_id, role) {
    const { issueAgentToken } = await import('../src/auth.mjs');
    const { token } = await issueAgentToken(
      { queryOne: (s, p) => db.queryOne(s, p), queryAll: (s, p) => db.queryAll(s, p),
        batch: (stmts) => db.batch(stmts) },
      { agent_id, display_name: agent_id, role }, { by: 'david' });
    return token;
  }

  const pngMagic = async (r) => {
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // P
    assert.equal(buf[2], 0x4e); // N
    assert.equal(buf[3], 0x47); // G
    return buf.length;
  };

  it('unauthenticated icon/manifest/favicon requests redirect to login (never 404)', async () => {
    for (const p of ['/dashboard/manifest.webmanifest', '/dashboard/icons/icon-192.png',
                     '/dashboard/icons/apple-touch-icon.png', '/favicon.ico']) {
      const r = await get(p);
      assert.equal(r.status, 302, p);
      assert.ok(r.headers.get('location').includes('/auth/github/login'), p);
    }
  });

  it('unknown icon names are 404', async () => {
    const cookie = await davidCookie();
    const r = await get('/dashboard/icons/nope.png', { cookie });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'NOT_FOUND');
  });

  it('agents are refused icons and manifest with 403', async () => {
    const tok = await tokenFor('chatgpt', 'agent');
    const authz = { authorization: `Bearer ${tok}` };
    assert.equal((await get('/dashboard/manifest.webmanifest', authz)).status, 403);
    assert.equal((await get('/dashboard/icons/icon-192.png', authz)).status, 403);
    assert.equal((await get('/favicon.ico', authz)).status, 403);
  });

  it('David gets the manifest with correct content type and icon entries', async () => {
    const cookie = await davidCookie();
    const r = await get('/dashboard/manifest.webmanifest', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
    const m = await r.json();
    assert.equal(m.short_name, 'AI Hub');
    assert.equal(m.name, 'AI Coordination Hub');
    assert.equal(m.start_url, '/dashboard');
    assert.equal(m.display, 'standalone');
    assert.equal(m.icons.length, 3);
    const sizes = m.icons.map((i) => i.sizes).sort();
    assert.deepEqual(sizes, ['192x192', '512x512', '512x512']);
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    assert.ok(m.icons.every((i) => i.src.startsWith('/dashboard/icons/') && i.type === 'image/png'));
  });

  it('David gets each PNG icon with the right content type and real PNG bytes', async () => {
    const cookie = await davidCookie();
    for (const p of ['/dashboard/icons/apple-touch-icon.png', '/dashboard/icons/icon-192.png',
                     '/dashboard/icons/icon-512.png', '/dashboard/icons/icon-maskable-512.png']) {
      const r = await get(p, { cookie });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /image\/png/, p);
      const n = await pngMagic(r);
      assert.ok(n > 5000, `${p} too small: ${n}`);
    }
    const fav = await get('/favicon.ico', { cookie });
    assert.equal(fav.status, 200);
    assert.match(fav.headers.get('content-type'), /image\/png/);
    assert.ok((await pngMagic(fav)) > 1000);
  });

  it('dashboard head carries the iPhone install tags', async () => {
    const cookie = await davidCookie();
    const html = await (await get('/', { cookie })).text();
    assert.ok(html.includes('viewport-fit=cover'), 'viewport-fit=cover');
    assert.ok(html.includes('rel="apple-touch-icon"'), 'apple-touch-icon');
    assert.ok(html.includes('/dashboard/icons/apple-touch-icon.png'), 'touch icon href');
    assert.ok(html.includes('rel="manifest"'), 'manifest link');
    assert.ok(html.includes('/dashboard/manifest.webmanifest'), 'manifest href');
    assert.ok(html.includes('apple-mobile-web-app-capable'), 'web-app-capable');
    assert.ok(html.includes('apple-mobile-web-app-title'), 'web-app-title');
    assert.ok(html.includes('content="AI Hub"'), 'AI Hub title');
    assert.ok(html.includes('apple-mobile-web-app-status-bar-style'), 'status-bar-style');
    assert.ok(html.includes('name="theme-color"'), 'theme-color');
  });

  it('dashboard body has the chat thread + composer, not the old command bar', async () => {
    const cookie = await davidCookie();
    const html = await (await get('/', { cookie })).text();
    assert.ok(html.includes('id="thread"'), 'thread');
    assert.ok(html.includes('id="threadScroll"'), 'threadScroll');
    assert.ok(html.includes('id="composer"'), 'composer');
    assert.ok(html.includes('id="composerWrap"'), 'composerWrap');
    assert.ok(html.includes('id="cmdInput"'), 'cmdInput');
    assert.ok(html.includes('id="slashBtn"'), 'slashBtn');
    assert.ok(html.includes('id="cmdSend"'), 'cmdSend');
    assert.ok(html.includes('id="typingRow"'), 'typingRow');
    assert.ok(html.includes('id="cmdMenu"'), 'cmdMenu');
    assert.ok(html.includes('id="chipRow"'), 'chipRow');
    assert.ok(html.includes('id="newMsgPill"'), 'newMsgPill');
    assert.ok(!html.includes('id="cmdAction"'), 'old action select gone');
    assert.ok(!html.includes('id="cmdTask"'), 'old task select gone');
    assert.ok(!html.includes('id="cmdbar"'), 'old footer gone');
    // The control-tower sections are intact.
    for (const id of ['needsDavid', 'needsMateo', 'taskList', 'agentList', 'activityList']) {
      assert.ok(html.includes('id="' + id + '"'), id + ' intact');
    }
  });

  it('dashboard JS carries the iPhone mechanics', async () => {
    const cookie = await davidCookie();
    const js = await (await get('/dashboard/app.js', { cookie })).text();
    assert.ok(js.includes('visualViewport'), 'visualViewport keyboard offset');
    assert.ok(js.includes('safe-area-inset-bottom') || js.includes('env(safe-area-inset-bottom)') ||
      (await (await get('/dashboard/styles.css', { cookie })).text()).includes('env(safe-area-inset-bottom)'),
      'safe-area padding');
    assert.ok(js.includes('sessionStorage'), 'draft persistence');
    assert.ok(js.includes('renderThread'), 'thread renderer');
    assert.ok(js.includes('showTyping') && js.includes('hideTyping'), 'typing indicator');
    assert.ok(js.includes('newMsgPill') || js.includes('new messages'), 'new-messages pill');
    assert.ok(js.includes('pointer: coarse'), 'touch Enter behavior');
  });

  it('dashboard CSS keeps the composer input at 16px (no iOS zoom)', async () => {
    const cookie = await davidCookie();
    const css = await (await get('/dashboard/styles.css', { cookie })).text();
    assert.ok(css.includes('#cmdInput'), 'composer input styled');
    assert.ok(/font-size:\s*16px/.test(css), '16px input font');
    assert.ok(css.includes('100dvh'), 'dynamic viewport height');
    assert.ok(css.includes('44px'), '44pt tap targets');
  });

  it('/api/activity now carries payloads so the thread can render bodies', async () => {
    const cookie = await davidCookie();
    const post = (body) => handler.fetch(new Request('https://hub.example.com/api/commands', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const c = await post({ command: 'createTask', title: 'Chat', goal: 'G', idempotency_key: 'chat-k1' });
    const task_id = (await c.json()).task_id;
    const m = await post({ command: 'postMessage', task_id, body: 'hello team', idempotency_key: 'chat-k2' });
    assert.equal(m.status, 200);

    const act = await get('/api/activity?limit=10', { cookie });
    assert.equal(act.status, 200);
    const posted = (await act.json()).events.filter((e) => e.event_type === 'message.posted');
    assert.ok(posted.length >= 1);
    assert.equal(posted[posted.length - 1].payload.body, 'hello team');
    assert.equal(posted[posted.length - 1].actor_id, 'david');
  });
});

describe('task 016 per-agent bearer tokens', () => {
  const davidCookie = async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    return `hub_session=${sessionId}`;
  };

  const postAuth = (path, headers = {}, body = {}) =>
    handler.fetch(new Request(`https://hub.example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), env);

  async function issueAsDavid(agent_id, role = 'agent') {
    const cookie = await davidCookie();
    const r = await postAuth('/auth/agents', { cookie }, { agent_id, role });
    assert.equal(r.status, 201);
    return r.json();
  }

  it('a Mateo-role agent cannot issue tokens — issuance is David-only (403)', async () => {
    const { token } = await issueAsDavid('m1', 'mateo');
    const r = await postAuth('/auth/agents',
      { authorization: `Bearer ${token}` }, { agent_id: 'chatgpt', role: 'agent' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'FORBIDDEN');
  });

  it('David can revoke a token; it then authenticates as 401', async () => {
    const cookie = await davidCookie();
    const { token, token_id } = await issueAsDavid('claude');
    const before = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(before.status, 200);

    const rev = await postAuth('/auth/agents/revoke', { cookie }, { token_id });
    assert.equal(rev.status, 200);
    assert.equal((await rev.json()).token_id, token_id);

    const after = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(after.status, 401);
    assert.equal((await after.json()).code, 'AUTH_TOKEN_REVOKED');
  });

  it('revoking an unknown token_id is 400', async () => {
    const cookie = await davidCookie();
    const r = await postAuth('/auth/agents/revoke', { cookie }, { token_id: 'tok_nope' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'AUTH_UNKNOWN_TOKEN');
  });

  it('an agent cannot revoke tokens (403); unauthenticated revoke is 401', async () => {
    const { token, token_id } = await issueAsDavid('chatgpt');
    const asAgent = await postAuth('/auth/agents/revoke',
      { authorization: `Bearer ${token}` }, { token_id });
    assert.equal(asAgent.status, 403);

    const noAuth = await postAuth('/auth/agents/revoke', {}, { token_id });
    assert.equal(noAuth.status, 401);
  });

  it('brute-force: >20 failed bearer attempts from one IP are throttled (429)', async () => {
    const ip = { 'cf-connecting-ip': '10.9.9.9' };
    let last;
    for (let i = 0; i < 21; i++) {
      last = await get('/auth/me', { authorization: 'Bearer <redacted>', ...ip });
    }
    assert.equal(last.status, 429);
    assert.equal((await last.json()).code, 'RATE_LIMITED');
    // A different client is unaffected.
    const other = await get('/auth/me',
      { authorization: 'Bearer <redacted>', 'cf-connecting-ip': '10.9.9.10' });
    assert.equal(other.status, 401);
  });

  it('dashboard JS carries the issue-token affordance', async () => {
    const cookie = await davidCookie();
    const js = await (await get('/dashboard/app.js', { cookie })).text();
    assert.ok(js.includes('Issue agent token'), 'menu entry');
    assert.ok(js.includes("'/auth/agents'"), 'issuance endpoint');
    assert.ok(js.includes('mateo-watcher'), 'agent picker lists the watcher');
    assert.ok(js.includes('copy it now'), 'copy-once warning');
  });
});

describe('task 017 token management UI', () => {
  const davidCookie = async () => {
    const setCookie = await loginAsDavid();
    const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
    return `hub_session=${sessionId}`;
  };

  const postAuth = (path, headers = {}, body = {}) =>
    handler.fetch(new Request(`https://hub.example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), env);

  async function issueAsDavid(agent_id, role = 'agent') {
    const cookie = await davidCookie();
    const r = await postAuth('/auth/agents', { cookie }, { agent_id, role });
    assert.equal(r.status, 201);
    return r.json();
  }

  it('token list is David-only: 401 unauthenticated, 403 for an agent', async () => {
    const noAuth = await get('/auth/agents/tokens');
    assert.equal(noAuth.status, 401);

    const { token } = await issueAsDavid('chatgpt');
    const asAgent = await get('/auth/agents/tokens', { authorization: `Bearer ${token}` });
    assert.equal(asAgent.status, 403);
    assert.equal((await asAgent.json()).code, 'FORBIDDEN');
  });

  it('David sees token metadata — and it never leaks secret material', async () => {
    const { token_id } = await issueAsDavid('claude');
    const cookie = await davidCookie();
    const r = await get('/auth/agents/tokens', { cookie });
    assert.equal(r.status, 200);
    const { tokens } = await r.json();
    const row = tokens.find((t) => t.token_id === token_id);
    assert.ok(row, 'issued token is listed');
    assert.equal(row.agent_id, 'claude');
    const keys = Object.keys(row);
    assert.ok(!keys.includes('secret_hash'), 'no secret_hash key');
    assert.ok(!keys.includes('secret'), 'no secret key');
    assert.ok(!('secret_hash' in row) && !('secret' in row));
  });

  it('revoke via the manager flow: list shows active, then revoked; Bearer <redacted>', async () => {
    const cookie = await davidCookie();
    const { token, token_id } = await issueAsDavid('mateo-watcher');

    const list1 = await (await get('/auth/agents/tokens', { cookie })).json();
    const before = list1.tokens.find((t) => t.token_id === token_id);
    assert.ok(before && !before.revoked_at, 'starts active');

    const rev = await postAuth('/auth/agents/revoke', { cookie }, { token_id });
    assert.equal(rev.status, 200);

    const list2 = await (await get('/auth/agents/tokens', { cookie })).json();
    const after = list2.tokens.find((t) => t.token_id === token_id);
    assert.ok(after && after.revoked_at, 'renders as revoked');

    const authed = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(authed.status, 401);
  });

  it('token screens use existing routes with no secret material beyond one-time issuance', async () => {
    const cookie = await davidCookie();
    const issued = await issueAsDavid('chatgpt');
    const stored = db.queryOne('SELECT secret_hash FROM agent_tokens WHERE token_id = ?', [issued.token_id]);
    assert.ok(stored.secret_hash);
    assert.ok(!JSON.stringify(issued).includes(stored.secret_hash));
    const secret = issued.token.split('.')[1];
    const check = (body) => {
      const json = JSON.stringify(body);
      assert.ok(!json.includes('secret_hash'));
      assert.ok(!json.includes(stored.secret_hash));
      assert.ok(!json.includes(secret));
      assert.ok(!json.includes(issued.token));
    };
    const active = await (await get('/auth/agents/tokens', { cookie })).json();
    check(active);
    assert.ok(active.tokens.find(t => t.token_id === issued.token_id && !t.revoked_at));
    assert.equal((await get('/auth/me', { authorization: `Bearer ${issued.token}` })).status, 200);
    const revoke = await postAuth('/auth/agents/revoke', { cookie }, { token_id: issued.token_id });
    assert.equal(revoke.status, 200); check(await revoke.json());
    const revoked = await (await get('/auth/agents/tokens', { cookie })).json();
    check(revoked);
    assert.ok(revoked.tokens.find(t => t.token_id === issued.token_id && t.revoked_at));
    const rejected = await get('/auth/me', { authorization: `Bearer ${issued.token}` });
    assert.equal(rejected.status, 401); check(await rejected.json());
  });

  it('dashboard JS carries the token manager affordance', async () => {
    const cookie = await davidCookie();
    const js = await (await get('/dashboard/app.js', { cookie })).text();
    assert.ok(js.includes('Manage agent tokens'), 'menu entry');
    assert.ok(js.includes("'/auth/agents/tokens'"), 'list endpoint');
    assert.ok(js.includes('tokensBody'), 'manager screen');
    assert.ok(js.includes('Revoke'), 'revoke button');
    assert.ok(js.includes('Copy token'), 'copy button on issued-token modal');
  });

  it('dashboard HTML has the token screen and back navigation', async () => {
    const cookie = await davidCookie();
    const html = await (await get('/dashboard', { cookie })).text();
    assert.ok(html.includes('id="tokensScreen"'), 'token screen');
    assert.ok(html.includes('id="tokensBack"'), 'back button');
  });
});
