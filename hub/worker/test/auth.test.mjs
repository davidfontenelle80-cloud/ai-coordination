// auth.test.mjs — phase tests for task 008.
// Run: npm test   (node --test worker/test/)
// Real SQLite via node:sqlite with the exact D1 migration SQL.
// GitHub network calls are stubbed via an injectable fetch.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import {
  issueAgentToken, revokeAgentToken, authenticate, authorize,
  principalIdentity, applyPrincipalIdentity,
  beginGitHubLogin, completeGitHubLogin, logout,
  sha256Hex, timingSafeEqual,
} from '../src/auth.mjs';

const SCHEMA = readFileSync(new URL('../../db/migrations/0001_schema.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../../db/migrations/0002_auth.sql', import.meta.url), 'utf8');

const ENV = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  DAVID_GITHUB_ID: '12345678',
  OAUTH_REDIRECT_URI: 'https://hub.example.com/auth/github/callback',
};

let db;
let nowTick;
beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  nowTick = 1_700_000_000_000;
});
afterEach(() => { db.close(); });
const now = () => nowTick++;

const req = (headers = {}) =>
  new Request('https://hub.example.com/api/x', { headers });

async function issueAgent(agent_id = 'chatgpt', role = 'agent') {
  return issueAgentToken(db, { agent_id, display_name: agent_id, role }, { by: 'david', now: now() });
}

function stubFetch(userId) {
  return async (url) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return { json: async () => ({ access_token: 'gho_testtoken' }) };
    }
    if (url === 'https://api.github.com/user') {
      return { json: async () => ({ id: userId }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

async function davidLogin(t = now()) {
  const { state } = await beginGitHubLogin(ENV, db, { now: t });
  const { setCookie } = await completeGitHubLogin(
    ENV, db, { code: 'code123', state }, { now: t + 1000, fetchFn: stubFetch(12345678) });
  const sessionId = /^hub_session=([^;]+)/.exec(setCookie)[1];
  return { setCookie, sessionId };
}

// ---------------------------------------------------------------------------

describe('bearer tokens', () => {
  it('issues token_id.secret tokens and stores only the hash', async () => {
    const { token_id, secret, token } = await issueAgent();
    assert.match(token_id, /^tok_/);
    assert.equal(token, `${token_id}.${secret}`);
    const row = db.queryOne('SELECT * FROM agent_tokens WHERE token_id = ?', [token_id]);
    assert.ok(row);
    assert.equal(row.secret_hash, await sha256Hex(secret));
    assert.ok(!('secret' in row), 'plaintext secret must not be stored');
    // The secret itself must not appear anywhere in the row.
    assert.ok(!JSON.stringify(row).includes(secret));
  });

  it('authenticates a valid bearer token and stamps last_used_at', async () => {
    const { token } = await issueAgent('mateo', 'mateo');
    const before = db.queryOne('SELECT last_used_at FROM agent_tokens').last_used_at;
    const p = await authenticate(db, req({ authorization: `Bearer ${token}` }), { now: now() });
    assert.deepEqual(p, { kind: 'agent', agent_id: 'mateo', role: 'mateo' });
    const after = db.queryOne('SELECT last_used_at FROM agent_tokens').last_used_at;
    assert.ok(after >= before);
  });

  it('throttles last_used_at writes to protect the free D1 write quota', async () => {
    const { token } = await issueAgent('mateo', 'mateo');
    const t0 = 1_700_000_100_000;
    const authz = { authorization: `Bearer ${token}` };
    await authenticate(db, req(authz), { now: t0 });
    const stamped = db.queryOne('SELECT last_used_at FROM agent_tokens').last_used_at;
    assert.equal(stamped, t0);
    // A request 1 minute later: timestamp is fresh, no write.
    await authenticate(db, req(authz), { now: t0 + 60_000 });
    assert.equal(db.queryOne('SELECT last_used_at FROM agent_tokens').last_used_at, t0);
    // A request 11 minutes later: stale, one write.
    await authenticate(db, req(authz), { now: t0 + 11 * 60_000 });
    assert.equal(db.queryOne('SELECT last_used_at FROM agent_tokens').last_used_at, t0 + 11 * 60_000);
  });

  it('rejects a wrong bearer token', async () => {
    await issueAgent();
    await assert.rejects(
      authenticate(db, req({ authorization: 'Bearer tok_nope.wrongsecret' }), { now: now() }),
      (e) => e.code === 'AUTH_BAD_TOKEN');
    // Right id, wrong secret.
    const { token_id } = await issueAgent('codex', 'agent');
    await assert.rejects(
      authenticate(db, req({ authorization: `Bearer ${token_id}.wrongsecret` }), { now: now() }),
      (e) => e.code === 'AUTH_BAD_TOKEN');
  });

  it('rejects a revoked token', async () => {
    const { token_id, token } = await issueAgent();
    await revokeAgentToken(db, token_id, { by: 'david', now: now() });
    await assert.rejects(
      authenticate(db, req({ authorization: `Bearer ${token}` }), { now: now() }),
      (e) => e.code === 'AUTH_TOKEN_REVOKED');
  });

  it('rejects tokens for disabled agents', async () => {
    const { token } = await issueAgent();
    db.batch([{ sql: 'UPDATE agent_identities SET disabled_at = ? WHERE agent_id = ?', params: [now(), 'chatgpt'] }]);
    await assert.rejects(
      authenticate(db, req({ authorization: `Bearer ${token}` }), { now: now() }),
      (e) => e.code === 'AUTH_AGENT_DISABLED');
  });

  it('returns null when no credential is present', async () => {
    assert.equal(await authenticate(db, req(), { now: now() }), null);
  });

  it('rotate-before-revoke keeps the new token live', async () => {
    const old = await issueAgent();
    const fresh = await issueAgentToken(db, { agent_id: 'chatgpt', role: 'agent' }, { by: 'david', now: now() });
    await revokeAgentToken(db, old.token_id, { by: 'david', now: now() });
    const p = await authenticate(db, req({ authorization: `Bearer ${fresh.token}` }), { now: now() });
    assert.equal(p.agent_id, 'chatgpt');
  });
});

// ---------------------------------------------------------------------------

describe('authorization matrix', () => {
  const david = { kind: 'david' };
  const mateo = { kind: 'agent', agent_id: 'mateo', role: 'mateo' };
  const agent = { kind: 'agent', agent_id: 'chatgpt', role: 'agent' };

  it('agent cannot perform a Mateo action (review.record)', () => {
    assert.equal(authorize(agent, 'recordReview'), false);
    assert.equal(authorize(agent, 'createTask'), false);
    assert.equal(authorize(agent, 'agent.issue'), false);
  });

  it('agent can do agent actions', () => {
    for (const c of ['claimTask', 'startTask', 'blockTask', 'submitResult', 'postMessage', 'postHandoff', 'attachArtifact', 'setAgentStatus', 'requestDecision']) {
      assert.equal(authorize(agent, c), true, c);
    }
  });

  it('Mateo cannot impersonate a David decision', () => {
    assert.equal(authorize(mateo, 'resolveDecision'), false);
    assert.equal(authorize(mateo, 'taskOverride'), false);
    assert.equal(authorize(mateo, 'recordReview'), true);
    assert.equal(authorize(mateo, 'createTask'), true);
  });

  it('David can do everything, including overrides', () => {
    for (const c of ['resolveDecision', 'taskOverride', 'recordReview', 'claimTask', 'agent.issue', 'anything.unlisted']) {
      assert.equal(authorize(david, c), true, c);
    }
  });

  it('denies unauthenticated and unknown principals', () => {
    assert.equal(authorize(null, 'postMessage'), false);
    assert.equal(authorize({ kind: 'weird' }, 'postMessage'), false);
  });
});

// ---------------------------------------------------------------------------

describe('server-derived identity (ChatGPT 008 boundary)', () => {
  it('derives actor_id/submitted_by from the principal, never the body', () => {
    const agent = { kind: 'agent', agent_id: 'chatgpt', role: 'agent' };
    assert.deepEqual(principalIdentity(agent), { actor_id: 'chatgpt', submitted_by: 'chatgpt' });
    assert.deepEqual(principalIdentity({ kind: 'david' }), { actor_id: 'david', submitted_by: 'david' });

    // A bearer token can never mint provenance as another principal:
    // caller-supplied values are overwritten.
    const inbound = { command: 'recordReview', actor_id: 'mateo', submitted_by: 'mateo', payload: {} };
    const out = applyPrincipalIdentity(inbound, agent);
    assert.equal(out.actor_id, 'chatgpt');
    assert.equal(out.submitted_by, 'chatgpt');
    // The caller's object is not mutated.
    assert.equal(inbound.submitted_by, 'mateo');
  });

  it('requires authentication for identity', () => {
    assert.throws(() => principalIdentity(null), (e) => e.code === 'AUTH_REQUIRED');
  });
});

// ---------------------------------------------------------------------------

describe('GitHub OAuth for David', () => {
  it('begin returns an authorize URL with client_id and state', async () => {
    const { redirectUrl, state } = await beginGitHubLogin(ENV, db, { now: now() });
    const u = new URL(redirectUrl);
    assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(u.searchParams.get('client_id'), 'test-client-id');
    assert.equal(u.searchParams.get('redirect_uri'), ENV.OAUTH_REDIRECT_URI);
    assert.equal(u.searchParams.get('state'), state);
    const row = db.queryOne('SELECT * FROM oauth_states WHERE state_hash = ?', [await sha256Hex(state)]);
    assert.ok(row && !row.used_at);
  });

  it('complete creates a session cookie for the allowlisted numeric id', async () => {
    const { sessionId } = await davidLogin();
    assert.match(sessionId, /^[0-9a-f]{96}$/);
    const p = await authenticate(db, req({ cookie: `hub_session=${sessionId}` }), { now: now() });
    assert.equal(p.kind, 'david');
    assert.equal(p.github_user_id, 12345678);
  });

  it('rejects a non-allowlisted GitHub user', async () => {
    const t = now();
    const { state } = await beginGitHubLogin(ENV, db, { now: t });
    await assert.rejects(
      completeGitHubLogin(ENV, db, { code: 'c', state }, { now: t + 1, fetchFn: stubFetch(99999999) }),
      (e) => e.code === 'AUTH_NOT_ALLOWLISTED');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM david_sessions').c, 0);
  });

  it('rejects reused and expired states', async () => {
    const t = now();
    const { state } = await beginGitHubLogin(ENV, db, { now: t });
    await completeGitHubLogin(ENV, db, { code: 'c', state }, { now: t + 1, fetchFn: stubFetch(12345678) });
    await assert.rejects(
      completeGitHubLogin(ENV, db, { code: 'c2', state }, { now: t + 2, fetchFn: stubFetch(12345678) }),
      (e) => e.code === 'AUTH_STATE_INVALID');

    const { state: s2 } = await beginGitHubLogin(ENV, db, { now: t });
    await assert.rejects(
      completeGitHubLogin(ENV, db, { code: 'c', state: s2 }, { now: t + 11 * 60 * 1000, fetchFn: stubFetch(12345678) }),
      (e) => e.code === 'AUTH_STATE_INVALID');
  });

  it('rejects expired sessions and supports logout', async () => {
    const { sessionId, setCookie } = await davidLogin();
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);

    // Logout revokes.
    const r = await logout(db, req({ cookie: `hub_session=${sessionId}` }), { now: now() });
    assert.match(r.clearCookie, /Max-Age=0/);
    await assert.rejects(
      authenticate(db, req({ cookie: `hub_session=${sessionId}` }), { now: now() }),
      (e) => e.code === 'AUTH_SESSION_REVOKED');
  });

  it('rejects sessions past expiry', async () => {
    const t = now();
    const { sessionId } = await davidLogin(t);
    await assert.rejects(
      authenticate(db, req({ cookie: `hub_session=${sessionId}` }), { now: t + 31 * 24 * 3600 * 1000 }),
      (e) => e.code === 'AUTH_SESSION_EXPIRED');
  });
});

// ---------------------------------------------------------------------------

describe('crypto helpers', () => {
  it('timingSafeEqual compares in constant time', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.equal(timingSafeEqual(null, 'abc'), false);
  });
});
