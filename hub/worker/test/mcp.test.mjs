// mcp.test.mjs — task 019 MCP server over POST /mcp.
// Exercises the real Worker fetch handler against a fake D1 binding backed
// by node:sqlite (same harness as routes.test.mjs), plus direct calls into
// the JSON-RPC handler. Dependency-free.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import handler from '../src/index.mjs';
import { issueAgentToken, revokeAgentToken } from '../src/auth.mjs';
import { COMMANDS, COMMAND_SCHEMAS } from '../src/commands.mjs';
import { QUERIES } from '../src/queries.mjs';
import { handleJsonRpc, MCP_SERVER_INFO, MCP_PROTOCOL_VERSIONS } from '../src/mcp.mjs';

const SCHEMA = readFileSync(new URL('../../db/migrations/0001_schema.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../../db/migrations/0002_auth.sql', import.meta.url), 'utf8');
const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const ENV_BASE = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  DAVID_GITHUB_ID: '12345678',
  OAUTH_REDIRECT_URI: 'https://hub.example.com/auth/github/callback',
};

const QUERY_TOOLS = [
  'list_tasks', 'get_task', 'get_task_events', 'get_task_resume',
  'get_activity', 'list_decisions', 'list_agents', 'get_stats',
];
const COMMAND_TOOLS = [
  'create_task', 'claim_task', 'start_task', 'block_task', 'post_message',
  'submit_result', 'record_review', 'request_decision', 'resolve_decision',
  'post_handoff', 'attach_artifact', 'set_agent_status', 'set_priority',
];

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
beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  env = { ...ENV_BASE, DB: fakeD1(db) };
});
afterEach(() => db.close());

const dbAdapter = () => ({
  queryOne: (s, p) => db.queryOne(s, p),
  queryAll: (s, p) => db.queryAll(s, p),
  batch: (stmts) => db.batch(stmts),
});

async function tokenFor(agent_id, role = 'agent') {
  return issueAgentToken(dbAdapter(), { agent_id, display_name: agent_id, role }, { by: 'david' });
}

let rpcId = 0;
let keyTick = 0;
const idem = () => `mcp-key-${keyTick++}`;

// Raw POST /mcp.
function mcpRaw(body, headers = {}) {
  return handler.fetch(new Request('https://hub.example.com/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
}

// JSON-RPC request with a bearer token; returns { status, body }.
async function rpc(token, method, params, headers = {}) {
  const r = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) },
    token ? { authorization: `Bearer ${token}`, ...headers } : headers);
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}

async function callTool(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  assert.equal(r.body.jsonrpc, '2.0');
  assert.ok(r.body.result, `expected a result, got ${JSON.stringify(r.body)}`);
  const res = r.body.result;
  // text content and structuredContent carry the same hub envelope.
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  return res;
}

// REST twin for parity checks.
function restCommand(token, body) {
  return handler.fetch(new Request('https://hub.example.com/api/commands', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}
const restGet = (token, path) =>
  handler.fetch(new Request(`https://hub.example.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  }), env);

describe('task 019 MCP: protocol handshake', () => {
  it('initialize returns server info, tools capability, and no session id', async () => {
    const { token } = await tokenFor('claude');
    const r = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, rpcId);
    assert.equal(r.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.body.result.serverInfo, { name: 'ai-hub', version: PKG.version });
    assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(typeof r.body.result.instructions, 'string');
    assert.equal(r.headers.get('mcp-session-id'), null); // stateless
  });

  it('server version tracks the worker build (package.json)', () => {
    assert.equal(MCP_SERVER_INFO.name, 'ai-hub');
    assert.equal(MCP_SERVER_INFO.version, PKG.version);
  });

  it('initialize with an unsupported version offers the newest supported one', async () => {
    const { token } = await tokenFor('claude');
    const r = await rpc(token, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(r.body.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  });

  it('notifications/initialized is accepted with 202 and no body', async () => {
    const { token } = await tokenFor('claude');
    const r = await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: `Bearer ${token}` });
    assert.equal(r.status, 202);
    assert.equal(await r.text(), '');
  });

  it('ping returns an empty result', async () => {
    const { token } = await tokenFor('claude');
    const r = await rpc(token, 'ping');
    assert.deepEqual(r.body.result, {});
  });

  it('an unsupported MCP-Protocol-Version header is 400', async () => {
    const { token } = await tokenFor('claude');
    const r = await rpc(token, 'tools/list', undefined, { 'mcp-protocol-version': '1999-01-01' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, -32600);
    const ok = await rpc(token, 'tools/list', undefined, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(ok.status, 200);
  });

  it('GET /mcp is 405 (no SSE stream is offered)', async () => {
    const r = await handler.fetch(new Request('https://hub.example.com/mcp'), env);
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  });
});

describe('task 019 MCP: tool catalog', () => {
  it('tools/list returns all 21 tools (8 queries + 13 commands) with input schemas', async () => {
    const { token } = await tokenFor('claude');
    const r = await rpc(token, 'tools/list');
    assert.equal(r.status, 200);
    const tools = r.body.result.tools;
    assert.equal(tools.length, 21);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...QUERY_TOOLS, ...COMMAND_TOOLS].sort());
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object', `${t.name} inputSchema`);
      assert.ok(t.inputSchema.properties, `${t.name} properties`);
    }
    for (const name of COMMAND_TOOLS) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t.inputSchema.required.includes('idempotency_key'), `${name} requires idempotency_key`);
      assert.equal(t.annotations.readOnlyHint, false);
    }
    for (const name of QUERY_TOOLS) {
      assert.equal(tools.find((x) => x.name === name).annotations.readOnlyHint, true);
    }
  });

  it('the catalog is generated from the REST tables, so it covers them exactly', () => {
    assert.deepEqual(Object.keys(QUERIES).sort(), [...QUERY_TOOLS].sort());
    assert.deepEqual(Object.keys(COMMAND_SCHEMAS).sort(), [...COMMANDS].sort());
    assert.equal(COMMANDS.length, 13);
  });

  it('token issuance / revocation / inventory are not exposed as tools', async () => {
    const { token } = await tokenFor('claude', 'mateo');
    const tools = (await rpc(token, 'tools/list')).body.result.tools;
    for (const t of tools) {
      assert.doesNotMatch(t.name, /token|revoke|issue/i);
      assert.doesNotMatch(t.description, /\/auth\/agents/);
    }
    for (const name of ['issue_agent_token', 'revoke_agent_token', 'list_agent_tokens']) {
      const r = await rpc(token, 'tools/call', { name, arguments: {} });
      assert.equal(r.body.error.code, -32602);
    }
  });
});

describe('task 019 MCP: authentication (same path as REST)', () => {
  it('missing token is 401 AUTH_REQUIRED, the same body as the REST API', async () => {
    const r = await rpc(null, 'tools/list');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, code: 'AUTH_REQUIRED', message: 'authentication required' });
    const rest = await handler.fetch(new Request('https://hub.example.com/api/tasks'), env);
    assert.equal(rest.status, 401);
    assert.deepEqual(await rest.json(), r.body);
  });

  it('an unauthenticated initialize is rejected too', async () => {
    const r = await rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'AUTH_REQUIRED');
  });

  it('invalid and unknown bearer tokens fail as AUTH_BAD_TOKEN 401', async () => {
    const malformed = await rpc('not-a-token', 'tools/list');
    assert.equal(malformed.status, 401);
    assert.equal(malformed.body.code, 'AUTH_BAD_TOKEN');
    const { token } = await tokenFor('claude');
    const wrongSecret = await rpc(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'tools/list');
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongSecret.body.code, 'AUTH_BAD_TOKEN');
  });

  it('a revoked token fails as AUTH_TOKEN_REVOKED', async () => {
    const { token, token_id } = await tokenFor('claude');
    assert.equal((await rpc(token, 'tools/list')).status, 200);
    await revokeAgentToken(dbAdapter(), token_id, { by: 'david' });
    const r = await rpc(token, 'tools/list');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'AUTH_TOKEN_REVOKED');
  });

  it("David's GitHub session cookie is not accepted on /mcp", async () => {
    // Insert a live David session directly (the OAuth flow is covered in
    // routes.test.mjs); the cookie authenticates on REST but not on /mcp.
    const { sha256Hex } = await import('../src/auth.mjs');
    const sessionId = 'test-session-id-019';
    const now = Date.now();
    db.batch([{
      sql: `INSERT INTO david_sessions (session_hash, github_user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)`,
      params: [await sha256Hex(sessionId), 12345678, now, now + 3_600_000],
    }]);
    const cookie = `hub_session=${sessionId}`;
    const rest = await handler.fetch(new Request('https://hub.example.com/api/tasks', { headers: { cookie } }), env);
    assert.equal(rest.status, 200);
    const r = await rpc(null, 'tools/list', undefined, { cookie });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'AUTH_REQUIRED');
  });

  it('failed bearer attempts on /mcp feed the same brute-force limiter (429)', async () => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await rpc('tok_nope.bad', 'tools/list', undefined, { 'cf-connecting-ip': '10.19.19.19' });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'RATE_LIMITED');
  });
});

describe('task 019 MCP: tools/call', () => {
  async function seedTask(mateoTok, task_id = 'mcp_task1') {
    const r = await restCommand(mateoTok, {
      command: 'createTask', task_id, title: 'MCP task', goal: 'Prove MCP', idempotency_key: idem(),
    });
    assert.equal(r.status, 200);
    return task_id;
  }

  it('get_activity with a valid agent bearer returns activity', async () => {
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    await seedTask(mateo);
    const { token } = await tokenFor('claude');
    const res = await callTool(token, 'get_activity', { limit: 10 });
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.ok, true);
    assert.ok(res.structuredContent.events.some((e) => e.event_type === 'task.created' && e.task_id === 'mcp_task1'));
  });

  it('post_message posts attributed to the calling agent, visible via get_activity', async () => {
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    const task_id = await seedTask(mateo);
    const { token } = await tokenFor('claude');
    const res = await callTool(token, 'post_message', {
      task_id, body: 'hello from MCP', idempotency_key: idem(),
      // Caller-supplied provenance is discarded by the command layer.
      actor_id: 'david', submitted_by: 'david', command: 'resolveDecision',
    });
    assert.equal(res.isError, false, JSON.stringify(res.structuredContent));
    assert.equal(res.structuredContent.command, 'postMessage');
    assert.equal(res.structuredContent.event_type, 'message.posted');

    const act = await callTool(token, 'get_activity', {});
    const msg = act.structuredContent.events.find((e) => e.event_type === 'message.posted');
    assert.equal(msg.actor_id, 'claude');
    assert.equal(msg.submitted_by, 'claude');
    assert.equal(msg.payload.body, 'hello from MCP');
  });

  it('an ordinary agent gets the same FORBIDDEN via MCP as via REST', async () => {
    const { token } = await tokenFor('claude');
    // createTask is Mateo/David-only (central authorize()).
    const rest = await restCommand(token, { command: 'createTask', title: 'T', goal: 'G', idempotency_key: idem() });
    assert.equal(rest.status, 403);
    const restBody = await rest.json();
    const res = await callTool(token, 'create_task', { title: 'T', goal: 'G', idempotency_key: idem() });
    assert.equal(res.isError, true);
    assert.deepEqual(res.structuredContent, restBody);
    assert.equal(res.structuredContent.code, 'FORBIDDEN');

    // resolveDecision is David-only; even a Mateo token is refused.
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    const rd = await callTool(mateo, 'resolve_decision', { decision_id: 'dec_x', resolution: 'yes', idempotency_key: idem() });
    assert.equal(rd.isError, true);
    assert.equal(rd.structuredContent.code, 'FORBIDDEN');
  });

  it('builder-level rules hold too: an agent cannot start a task assigned to someone else', async () => {
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    const task_id = await seedTask(mateo);
    const { token: gpt } = await tokenFor('chatgpt');
    const { token: claude } = await tokenFor('claude');
    assert.equal((await callTool(gpt, 'claim_task', { task_id, idempotency_key: idem() })).isError, false);
    const res = await callTool(claude, 'start_task', { task_id, idempotency_key: idem() });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'FORBIDDEN');
    assert.match(res.structuredContent.message, /assigned to chatgpt/);
    // And the owner can.
    assert.equal((await callTool(gpt, 'start_task', { task_id, idempotency_key: idem() })).isError, false);
  });

  it('bad params fail as VALIDATION_FAILED with the same message as REST', async () => {
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    const task_id = await seedTask(mateo);
    const { token } = await tokenFor('claude');

    const restBody = await (await restCommand(token, { command: 'postMessage', task_id, idempotency_key: idem() })).json();
    const res = await callTool(token, 'post_message', { task_id, idempotency_key: idem() });
    assert.equal(res.isError, true);
    assert.deepEqual(res.structuredContent, restBody);
    assert.equal(res.structuredContent.code, 'VALIDATION_FAILED');

    // idempotency_key is required, exactly as over REST.
    const noKey = await callTool(token, 'post_message', { task_id, body: 'x' });
    assert.equal(noKey.structuredContent.code, 'VALIDATION_FAILED');
    assert.match(noKey.structuredContent.message, /idempotency_key is required/);

    // https-only URL rule.
    const badUri = await callTool(token, 'attach_artifact', { name: 'a', uri: 'http://x.test/a', idempotency_key: idem() });
    assert.equal(badUri.structuredContent.code, 'VALIDATION_FAILED');

    // Query tools: required and typed arguments.
    const noId = await callTool(token, 'get_task', {});
    assert.equal(noId.isError, true);
    assert.equal(noId.structuredContent.code, 'VALIDATION_FAILED');
    const badLimit = await callTool(token, 'get_activity', { limit: 'ten' });
    assert.equal(badLimit.structuredContent.code, 'VALIDATION_FAILED');
    const badType = await callTool(token, 'list_tasks', { status: { $ne: 1 } });
    assert.equal(badType.structuredContent.code, 'VALIDATION_FAILED');
  });

  it('non-object arguments and unknown tools are JSON-RPC -32602', async () => {
    const { token } = await tokenFor('claude');
    const arr = await rpc(token, 'tools/call', { name: 'get_activity', arguments: [1] });
    assert.equal(arr.status, 200);
    assert.equal(arr.body.error.code, -32602);
    const unknown = await rpc(token, 'tools/call', { name: 'drop_tables', arguments: {} });
    assert.equal(unknown.body.error.code, -32602);
    const noName = await rpc(token, 'tools/call', {});
    assert.equal(noName.body.error.code, -32602);
  });

  it('query tools return exactly what the REST API returns', async () => {
    const { token: mateo } = await tokenFor('mateo', 'mateo');
    const task_id = await seedTask(mateo);
    const { token } = await tokenFor('claude');
    const pairs = [
      ['get_task', { task_id }, `/api/tasks/${task_id}`],
      ['list_tasks', { status: 'pending' }, '/api/tasks?status=pending'],
      ['get_task_events', { task_id, after_seq: 0 }, `/api/tasks/${task_id}/events?after_seq=0`],
      ['get_task_resume', { task_id }, `/api/tasks/${task_id}/resume`],
      ['list_decisions', {}, '/api/decisions'],
      ['list_agents', {}, '/api/agents'],
    ];
    for (const [tool, args, path] of pairs) {
      const res = await callTool(token, tool, args);
      assert.deepEqual(res.structuredContent, await (await restGet(token, path)).json(), tool);
    }
    // Not-found parity.
    const missing = await callTool(token, 'get_task', { task_id: 'nope' });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.structuredContent, await (await restGet(token, '/api/tasks/nope')).json());
    // get_stats: same keys (values can race the clock at midnight).
    const stats = await callTool(token, 'get_stats', {});
    assert.equal(stats.structuredContent.ok, true);
    assert.equal(stats.structuredContent.stats.tasks_total, 1);
  });

  it('command tools share the REST per-agent command rate limit', async () => {
    const { token } = await tokenFor('rl-agent');
    // 120 REST commands (cheap: rejected for a missing key after the rate
    // check) exhaust the bucket; the next MCP command call is limited.
    for (let i = 0; i < 120; i++) {
      const r = await restCommand(token, { command: 'postMessage' });
      assert.equal(r.status, 400);
    }
    const res = await callTool(token, 'post_message', { task_id: 't', body: 'b', idempotency_key: idem() });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'RATE_LIMITED');
    assert.equal(res.structuredContent.retryable, true);
    // Reads are not rate-limited, as over REST.
    assert.equal((await callTool(token, 'get_activity', {})).isError, false);
  });
});

describe('task 019 MCP: malformed JSON-RPC', () => {
  it('malformed JSON is a -32700 parse error (400), not a 500 or a leak', async () => {
    const { token } = await tokenFor('claude');
    const r = await mcpRaw('{"jsonrpc": "2.0", "id": 1, "method": ', { authorization: `Bearer ${token}` });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { jsonrpc: '2.0', id: null, error: { code: -32700, message: body.error.message } });
    assert.doesNotMatch(body.error.message, /at |SyntaxError|position/);
  });

  it('invalid envelopes are -32600; unknown methods are -32601', async () => {
    const { token } = await tokenFor('claude');
    const auth = { authorization: `Bearer ${token}` };
    const noVersion = await (await mcpRaw({ id: 1, method: 'tools/list' }, auth)).json();
    assert.equal(noVersion.error.code, -32600);
    const batch = await mcpRaw([{ jsonrpc: '2.0', id: 1, method: 'ping' }], auth);
    assert.equal(batch.status, 400);
    assert.equal((await batch.json()).error.code, -32600);
    const badId = await (await mcpRaw({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, auth)).json();
    assert.equal(badId.error.code, -32600);
    const scalar = await (await mcpRaw('42', auth)).json();
    assert.equal(scalar.error.code, -32600);

    const unknown = await rpc(token, 'resources/list');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.error.code, -32601);
    assert.equal(unknown.body.id, rpcId);
    const badParams = await rpc(token, 'tools/list', undefined);
    assert.equal(badParams.status, 200);
    const arrParams = await (await mcpRaw({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: [] }, auth)).json();
    assert.equal(arrParams.error.code, -32602);
  });

  it('an oversized body is rejected before parsing', async () => {
    const { token } = await tokenFor('claude');
    const r = await mcpRaw({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1024 * 1024) },
      { authorization: `Bearer ${token}` });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, -32600);
  });

  it('an unexpected tool failure is -32603 with no internal detail', async () => {
    const boom = { queryOne: async () => { throw new Error('SQLITE_SECRET_DETAIL'); },
      queryAll: async () => { throw new Error('SQLITE_SECRET_DETAIL'); } };
    const origError = console.error;
    console.error = () => {};
    try {
      const res = await handleJsonRpc(boom, { kind: 'agent', agent_id: 'claude', role: 'agent' },
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_activity', arguments: {} } }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'internal error' } });
    } finally {
      console.error = origError;
    }
  });
});
