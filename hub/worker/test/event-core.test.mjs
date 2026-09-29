// event-core.test.mjs — phase tests for task 007.
// Run: npm test   (node --test worker/test/)
// These tests run against real SQLite via node:sqlite with the exact
// D1 migration SQL, exercising the atomic-batch concurrency model.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import { appendEvent, rebuildProjections, EVENT_TYPES } from '../src/event-core.mjs';

const SCHEMA = readFileSync(new URL('../../db/migrations/0001_schema.sql', import.meta.url), 'utf8');

let db;
let nowTick;

beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  nowTick = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
});

const now = () => nowTick++;

function createTask(input = {}) {
  return appendEvent(db, {
    event_type: 'task.created',
    actor_id: 'mateo',
    submitted_by: 'mateo',
    idempotency_key: input.key || 'create-1',
    task_id: input.task_id,
    payload: { title: input.title || 'Test task', goal: input.goal || 'Prove the core works', priority: 'high' },
  }, { now: now() });
}

// ---------------------------------------------------------------------------

describe('schema + basic append', () => {
  it('applies the migration and appends task.created with version == seq == 1', () => {
    const r = createTask();
    assert.equal(r.ok, true);
    assert.equal(r.event.seq, 1);
    const t = db.queryOne('SELECT * FROM tasks WHERE task_id = ?', [r.event.task_id]);
    assert.equal(t.status, 'pending');
    assert.equal(t.version, 1);
    assert.equal(t.title, 'Test task');
  });

  it('exposes all 9 accepted event types', () => {
    assert.deepEqual([...EVENT_TYPES].sort(), [
      'agent.status_changed', 'artifact.attached', 'decision.changed',
      'handoff.posted', 'message.posted', 'result.submitted',
      'review.recorded', 'task.changed', 'task.created',
    ].sort());
  });

  it('rejects unknown event types and malformed payloads without writing', () => {
    const bad = appendEvent(db, {
      event_type: 'task.nuked', actor_id: 'x', submitted_by: 'x',
      idempotency_key: 'k1', payload: {},
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'VALIDATION_FAILED');

    const bad2 = appendEvent(db, {
      event_type: 'task.created', actor_id: 'x', submitted_by: 'x',
      idempotency_key: 'k2', payload: { title: 'no goal' },
    });
    assert.equal(bad2.ok, false);
    assert.equal(bad2.code, 'VALIDATION_FAILED');

    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM tasks').c, 0);
  });

  it('rejects illegal status transitions without writing', () => {
    const c = createTask();
    const r = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'bad-transition', task_id: c.event.task_id,
      expected_task_version: 1,
      payload: { field: 'status', from: 'pending', to: 'completed', reason: 'skip' },
    }, { now: now() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.match(r.message, /illegal status transition/);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 1);
  });
});

// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('idempotent retry creates exactly one event and returns the original', () => {
    const c = createTask({ key: 'idem-1' });
    assert.equal(c.ok, true);

    // Retry with the same key but a DIFFERENT payload: must still return the original.
    const r = appendEvent(db, {
      event_type: 'task.created', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'idem-1', task_id: 'task_should_be_ignored',
      payload: { title: 'Different', goal: 'Different' },
    }, { now: now() });
    assert.equal(r.ok, true);
    assert.equal(r.replayed, true);
    assert.equal(r.event.event_id, c.event.event_id);
    assert.equal(r.event.task_id, c.event.task_id);

    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 1);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM tasks').c, 1);
  });

  it('concurrent identical retries collapse to exactly one event', async () => {
    const dbPath = join(tmpdir(), `hub-race-idem-${process.pid}-${Date.now()}.db`);
    const fileDb = openDb(dbPath);
    applySchema(fileDb, SCHEMA);
    fileDb.close();

    const input = {
      event_type: 'task.created', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'idem-race', payload: { title: 'T', goal: 'G' },
    };
    const run = () => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./claim-racer.mjs', import.meta.url),
        { workerData: { dbPath, input } });
      w.once('message', resolve);
      w.once('error', reject);
    });
    const results = await Promise.all([run(), run(), run(), run()]);
    assert.ok(results.every((r) => r.ok));
    const ids = new Set(results.map((r) => r.event_id));
    assert.equal(ids.size, 1, 'all retries must return the same event');

    const check = openDb(dbPath);
    try {
      assert.equal(check.queryOne('SELECT COUNT(*) c FROM events').c, 1);
    } finally {
      check.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('optimistic concurrency', () => {
  it('stale expected_task_version returns VERSION_CONFLICT and writes nothing', () => {
    const c = createTask();
    const t = c.event.task_id;

    const first = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'chg-1', task_id: t, expected_task_version: 1,
      payload: { field: 'assignee', from: null, to: 'chatgpt', reason: 'assign' },
    }, { now: now() });
    assert.equal(first.ok, true);
    assert.equal(first.event.seq, 2);

    // Stale: still expects version 1, but the task is now at 2.
    const stale = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'chg-2', task_id: t, expected_task_version: 1,
      payload: { field: 'assignee', from: 'chatgpt', to: 'codex', reason: 'reassign' },
    }, { now: now() });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'VERSION_CONFLICT');
    assert.equal(stale.current_task_version, 2);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 2);
    assert.equal(db.queryOne('SELECT assignee FROM tasks WHERE task_id = ?', [t]).assignee, 'chatgpt');
  });

  it('batch is atomic: a failing statement rolls back event + projection together', () => {
    const c = createTask();
    const t = c.event.task_id;
    // Force a UNIQUE(scope, seq) collision on seq=1 plus a projection write
    // in the same batch: the projection write must roll back too.
    assert.throws(() => db.batch([
      { sql: `INSERT INTO events (event_id, task_id, seq, event_type, actor_id, submitted_by,
                                  created_at, caused_by_event_id, idempotency_key,
                                  schema_version, payload)
              VALUES ('evt_dup', ?, 1, 'task.changed', 'x', 'x', 1, NULL, 'k_dup', 1, '{}')`,
        params: [t] },
      { sql: `UPDATE tasks SET priority = 'low' WHERE task_id = ?`, params: [t] },
    ]), /UNIQUE constraint failed/i);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 1);
    assert.equal(
      db.queryOne('SELECT priority FROM tasks WHERE task_id = ?', [t]).priority, 'high');
  });

  it('simultaneous claims across threads produce exactly one winner', async () => {
    const dbPath = join(tmpdir(), `hub-race-claim-${process.pid}-${Date.now()}.db`);
    const setup = openDb(dbPath);
    applySchema(setup, SCHEMA);
    const c = appendEvent(setup, {
      event_type: 'task.created', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'race-create', task_id: 'task_race',
      payload: { title: 'Race', goal: 'One winner' },
    });
    assert.equal(c.ok, true);
    setup.close();

    const N = 8;
    const run = (i) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./claim-racer.mjs', import.meta.url), {
        workerData: {
          dbPath,
          input: {
            event_type: 'task.changed', actor_id: `agent-${i}`, submitted_by: `agent-${i}`,
            idempotency_key: `claim-${i}`, task_id: 'task_race',
            expected_task_version: 1, // all racers read the same stale version
            payload: { field: 'assignee', from: null, to: `agent-${i}`, reason: 'claim race' },
          },
        },
      });
      w.once('message', resolve);
      w.once('error', reject);
    });
    const results = await Promise.all(Array.from({ length: N }, (_, i) => run(i)));

    const winners = results.filter((r) => r.ok && !r.replayed);
    const conflicts = results.filter((r) => !r.ok && r.code === 'VERSION_CONFLICT');
    assert.equal(winners.length, 1, `exactly one winner, got ${JSON.stringify(results)}`);
    assert.equal(conflicts.length, N - 1);

    const check = openDb(dbPath);
    try {
      // Exactly one claim event; projection assignee matches the winner.
      assert.equal(check.queryOne("SELECT COUNT(*) c FROM events WHERE event_type = 'task.changed'").c, 1);
      const t = check.queryOne('SELECT assignee, version FROM tasks WHERE task_id = ?', ['task_race']);
      assert.equal(t.version, 2);
      const winnerEvent = check.queryOne(
        "SELECT actor_id FROM events WHERE event_type = 'task.changed'", []);
      assert.equal(t.assignee, winnerEvent.actor_id);
    } finally {
      check.close();
      rmSync(dbPath, { force: true });
    }
  }, { timeout: 60000 });
});

// ---------------------------------------------------------------------------

describe('lifecycle + rebuild', () => {
  function runScenario() {
    const a = createTask({ key: 'sc-create', task_id: 'task_alpha' }).event;
    appendEvent(db, {
      event_type: 'message.posted', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-msg1', task_id: a.task_id, expected_task_version: 1,
      payload: { kind: 'proposal', body: 'Here is the plan' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-claim', task_id: a.task_id, expected_task_version: 2,
      payload: { field: 'status', from: 'pending', to: 'claimed', reason: 'assign to chatgpt' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-assignee', task_id: a.task_id, expected_task_version: 3,
      payload: { field: 'assignee', from: null, to: 'chatgpt', reason: 'assign' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-start', task_id: a.task_id, expected_task_version: 4,
      payload: { field: 'status', from: 'claimed', to: 'in-progress', reason: 'starting' },
    }, { now: now() });
    const res = appendEvent(db, {
      event_type: 'result.submitted', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-result', task_id: a.task_id, expected_task_version: 5,
      payload: { summary: 'Done', evidence: { tests: '9/9' }, links: ['https://example.com/x'] },
    }, { now: now() }).event;
    appendEvent(db, {
      event_type: 'review.recorded', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-review', task_id: a.task_id, expected_task_version: 6,
      caused_by_event_id: res.event_id,
      payload: { outcome: 'accepted', notes: 'Solid work' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-complete', task_id: a.task_id, expected_task_version: 7,
      payload: { field: 'status', from: 'under-review', to: 'completed', reason: 'accepted' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-dec-req', task_id: a.task_id, expected_task_version: 8,
      payload: { decision_id: 'dec_ship', phase: 'requested', question: 'Ship it?',
                 options: ['yes', 'no'] },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'david', submitted_by: 'david',
      idempotency_key: 'sc-dec-res', task_id: a.task_id, expected_task_version: 9,
      payload: { decision_id: 'dec_ship', phase: 'resolved', resolution: 'yes' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'handoff.posted', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-handoff', task_id: a.task_id, expected_task_version: 10,
      payload: { goal: 'Wrap up', done: ['built'], pending: [], key_context: 'ctx',
                 references: [], reason: 'done', agent_id: 'chatgpt' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'artifact.attached', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-art', task_id: a.task_id, expected_task_version: 11,
      payload: { artifact_id: 'art_report', name: 'report.md', mime_type: 'text/markdown',
                 uri: 'https://github.com/x/report.md', sha256: 'abc123' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'agent.status_changed', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'sc-status',
      payload: { agent_id: 'chatgpt', context_health: 'watch', work_state: 'idle', current_task_id: null },
    }, { now: now() });
    const b = createTask({ key: 'sc-create-b', task_id: 'task_beta', title: 'Second task' }).event;
    appendEvent(db, {
      event_type: 'message.posted', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'sc-msg-b', task_id: b.task_id, expected_task_version: 1,
      payload: { kind: 'question', body: 'Status?' },
    }, { now: now() });
    return { a: a.task_id, b: b.task_id };
  }

  function snapshot() {
    const canon = (rows) => rows.map((r) => {
      const o = {};
      for (const k of Object.keys(r).sort()) {
        if (/(message_id|result_id|review_id|handoff_id)$/.test(k)) continue; // autoincrement, not stable across rebuild
        o[k] = r[k];
      }
      return o;
    });
    return {
      tasks: canon(db.queryAll('SELECT * FROM tasks ORDER BY task_id', [])),
      messages: canon(db.queryAll('SELECT * FROM messages ORDER BY event_id', [])),
      results: canon(db.queryAll('SELECT * FROM results ORDER BY event_id', [])),
      reviews: canon(db.queryAll('SELECT * FROM reviews ORDER BY event_id', [])),
      decisions: canon(db.queryAll('SELECT * FROM decisions ORDER BY decision_id', [])),
      handoffs: canon(db.queryAll('SELECT * FROM handoffs ORDER BY event_id', [])),
      artifact_refs: canon(db.queryAll('SELECT * FROM artifact_refs ORDER BY artifact_id', [])),
      agents: canon(db.queryAll('SELECT * FROM agents ORDER BY agent_id', [])),
    };
  }

  it('full lifecycle projects correctly, then rebuild reproduces it exactly', () => {
    const ids = runScenario();

    // Sanity on the live projections first.
    const ta = db.queryOne('SELECT * FROM tasks WHERE task_id = ?', [ids.a]);
    assert.equal(ta.status, 'completed');
    assert.equal(ta.version, 12);
    assert.equal(ta.assignee, 'chatgpt');
    assert.ok(ta.latest_result_event_id);
    assert.ok(ta.latest_review_event_id);
    const dec = db.queryOne('SELECT * FROM decisions WHERE decision_id = ?', ['dec_ship']);
    assert.equal(dec.phase, 'resolved');
    assert.equal(dec.resolution, 'yes');
    assert.equal(dec.version, 2);
    const ag = db.queryOne('SELECT * FROM agents WHERE agent_id = ?', ['chatgpt']);
    assert.equal(ag.context_health, 'watch');
    assert.equal(ag.work_state, 'idle');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 15);
    // seqs are contiguous per task scope.
    const seqsA = db.queryAll('SELECT seq FROM events WHERE task_id = ? ORDER BY seq', [ids.a])
      .map((r) => r.seq);
    assert.deepEqual(seqsA, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const live = snapshot();
    const { rebuilt_events } = rebuildProjections(db);
    assert.equal(rebuilt_events, 15);
    const rebuilt = snapshot();
    assert.deepEqual(rebuilt, live, 'rebuilt projections must equal live projections');

    // Events table itself is untouched by the rebuild.
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 15);
  });

  it('rebuild of an empty event stream yields empty projections', () => {
    const { rebuilt_events } = rebuildProjections(db);
    assert.equal(rebuilt_events, 0);
    for (const t of ['tasks', 'messages', 'results', 'reviews', 'decisions', 'handoffs', 'artifact_refs', 'agents']) {
      assert.equal(db.queryOne(`SELECT COUNT(*) c FROM ${t}`).c, 0);
    }
  });
});

// ---------------------------------------------------------------------------

describe('workspace-level events', () => {
  const status = (key, health, currentTaskId = null) => appendEvent(db, {
    event_type: 'agent.status_changed', actor_id: 'chatgpt', submitted_by: 'chatgpt',
    idempotency_key: key,
    payload: { agent_id: 'chatgpt', context_health: health, work_state: 'idle', current_task_id: currentTaskId },
  }, { now: now() });

  it('sequences multiple task-less events contiguously without throwing', () => {
    const r1 = status('ws-1', 'normal');
    const r2 = status('ws-2', 'watch');
    const r3 = status('ws-3', 'handoff-due');
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.deepEqual([r1.event.seq, r2.event.seq, r3.event.seq], [1, 2, 3]);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 3);
  });

  it('workspace events survive the projection rebuild with latest state', () => {
    status('ws-1', 'normal');
    status('ws-2', 'handoff-due');
    const live = db.queryOne('SELECT context_health, work_state FROM agents WHERE agent_id = ?', ['chatgpt']);
    rebuildProjections(db);
    const rebuilt = db.queryOne('SELECT context_health, work_state FROM agents WHERE agent_id = ?', ['chatgpt']);
    assert.deepEqual(rebuilt, live);
    assert.equal(rebuilt.context_health, 'handoff-due');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 2);
  });
});

// ---------------------------------------------------------------------------
// ChatGPT review hardening (task 014)
// ---------------------------------------------------------------------------

describe('idempotency vs state validation', () => {
  it('repeating a committed status change replays instead of failing the transition', () => {
    const c = createTask({ key: 'idem-st-create', task_id: 'task_idem_st' });
    const t = c.event.task_id;
    const first = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'idem-st-1', task_id: t, expected_task_version: 1,
      payload: { field: 'status', from: 'pending', to: 'claimed', reason: 'claim' },
    }, { now: now() });
    assert.equal(first.ok, true);
    assert.equal(first.replayed, undefined);

    // Identical retry: status is already claimed, so re-validating the
    // transition would reject claimed -> claimed. Must replay instead.
    const retry = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'idem-st-1', task_id: t, expected_task_version: 1,
      payload: { field: 'status', from: 'pending', to: 'claimed', reason: 'claim' },
    }, { now: now() });
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(retry.event.event_id, first.event.event_id);
    assert.equal(
      db.queryOne("SELECT COUNT(*) c FROM events WHERE event_type = 'task.changed'").c, 1);
  });
});

// ---------------------------------------------------------------------------

describe('scope enforcement', () => {
  it('rejects task-scoped events without task_id and workspace events with task_id', () => {
    const c = createTask({ key: 'scope-create' });
    const t = c.event.task_id;
    const cases = [
      ['task.changed', { field: 'assignee', to: 'x' }, null],
      ['message.posted', { kind: 'message', body: 'hi' }, null],
      ['result.submitted', { summary: 's' }, null],
      ['review.recorded', { outcome: 'accepted' }, null],
      ['agent.status_changed',
        { agent_id: 'x', context_health: 'normal', work_state: 'idle', current_task_id: null }, t],
    ];
    for (const [event_type, payload, task_id] of cases) {
      const r = appendEvent(db, {
        event_type, actor_id: 'x', submitted_by: 'x',
        idempotency_key: `scope-${event_type}`, task_id, payload,
      }, { now: now() });
      assert.equal(r.ok, false, `${event_type} should be scope-rejected`);
      assert.equal(r.code, 'VALIDATION_FAILED');
    }
    // Dual-scope types still work without task_id.
    const d = appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'scope-dec',
      payload: { decision_id: 'dec_scope', phase: 'requested', question: 'Q?' },
    }, { now: now() });
    assert.equal(d.ok, true);
    const h = appendEvent(db, {
      event_type: 'handoff.posted', actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'scope-ho', payload: { goal: 'g', agent_id: 'mateo' },
    }, { now: now() });
    assert.equal(h.ok, true);
  });

  it('keeps the invariant tasks.version == seq of last task-scoped event', () => {
    const c = createTask({ key: 'inv-create', task_id: 'task_inv' });
    const t = c.event.task_id;
    appendEvent(db, {
      event_type: 'message.posted', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'inv-msg', task_id: t, expected_task_version: 1,
      payload: { kind: 'message', body: 'hello' },
    }, { now: now() });
    // A workspace event must not disturb the task scope numbering.
    appendEvent(db, {
      event_type: 'agent.status_changed', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'inv-ws',
      payload: { agent_id: 'a', context_health: 'normal', work_state: 'idle', current_task_id: null },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'inv-dec', task_id: t, expected_task_version: 2,
      payload: { decision_id: 'dec_inv', phase: 'requested', question: 'Q?' },
    }, { now: now() });
    const row = db.queryOne('SELECT version FROM tasks WHERE task_id = ?', [t]);
    const lastSeq = db.queryOne('SELECT MAX(seq) m FROM events WHERE task_id = ?', [t]).m;
    assert.equal(row.version, 3);
    assert.equal(row.version, lastSeq);
  });
});

// ---------------------------------------------------------------------------

describe('deterministic projection ids', () => {
  it('requires decision_id and artifact_id in payloads', () => {
    const c = createTask({ key: 'det-create' });
    const t = c.event.task_id;
    const d = appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'det-dec', task_id: t, expected_task_version: 1,
      payload: { phase: 'requested', question: 'Q?' },
    }, { now: now() });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'VALIDATION_FAILED');
    const a = appendEvent(db, {
      event_type: 'artifact.attached', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'det-art', task_id: t, expected_task_version: 1,
      payload: { name: 'n', uri: 'https://x/y' },
    }, { now: now() });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'VALIDATION_FAILED');
  });

  it('rebuild reproduces the exact same decision and artifact ids', () => {
    const c = createTask({ key: 'det2-create' });
    const t = c.event.task_id;
    appendEvent(db, {
      event_type: 'decision.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'det2-dec', task_id: t, expected_task_version: 1,
      payload: { decision_id: 'dec_det', phase: 'requested', question: 'Q?' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'artifact.attached', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'det2-art', task_id: t, expected_task_version: 2,
      payload: { artifact_id: 'art_det', name: 'n', uri: 'https://x/y' },
    }, { now: now() });
    const before = {
      dec: db.queryOne('SELECT decision_id, phase FROM decisions', []),
      art: db.queryOne('SELECT artifact_id, name FROM artifact_refs', []),
    };
    rebuildProjections(db);
    const after = {
      dec: db.queryOne('SELECT decision_id, phase FROM decisions', []),
      art: db.queryOne('SELECT artifact_id, name FROM artifact_refs', []),
    };
    assert.deepEqual(after, before);
    assert.equal(after.dec.decision_id, 'dec_det');
    assert.equal(after.art.artifact_id, 'art_det');
  });
});

// ---------------------------------------------------------------------------

describe('result and review state gates', () => {
  function toInProgress(t, tag) {
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: `g-claim-${tag}`, task_id: t, expected_task_version: 1,
      payload: { field: 'status', from: 'pending', to: 'claimed', reason: 'c' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: `g-start-${tag}`, task_id: t, expected_task_version: 2,
      payload: { field: 'status', from: 'claimed', to: 'in-progress', reason: 's' },
    }, { now: now() });
  }

  it('rejects result.submitted unless in-progress; completed stays terminal', () => {
    const c = createTask({ key: 'g-create', task_id: 'task_gate' });
    const t = c.event.task_id;
    const early = appendEvent(db, {
      event_type: 'result.submitted', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'g-early', task_id: t, expected_task_version: 1,
      payload: { summary: 'too soon' },
    }, { now: now() });
    assert.equal(early.ok, false);
    assert.match(early.message, /in-progress/);

    toInProgress(t, 't1');
    const good = appendEvent(db, {
      event_type: 'result.submitted', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'g-good', task_id: t, expected_task_version: 3,
      payload: { summary: 'done' },
    }, { now: now() });
    assert.equal(good.ok, true);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'under-review');

    // review requires under-review: a task only at in-progress must fail.
    const c2 = createTask({ key: 'g-create2', task_id: 'task_gate2' });
    const t2 = c2.event.task_id;
    toInProgress(t2, 't2');
    const badReview = appendEvent(db, {
      event_type: 'review.recorded', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'g-badrev', task_id: t2, expected_task_version: 3,
      payload: { outcome: 'accepted' },
    }, { now: now() });
    assert.equal(badReview.ok, false);
    assert.match(badReview.message, /under-review/);

    // Finish task 1 through review -> completed, then prove terminal.
    appendEvent(db, {
      event_type: 'review.recorded', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'g-rev', task_id: t, expected_task_version: 4,
      payload: { outcome: 'accepted' },
    }, { now: now() });
    appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'g-done', task_id: t, expected_task_version: 5,
      payload: { field: 'status', from: 'under-review', to: 'completed', reason: 'ship' },
    }, { now: now() });
    const late = appendEvent(db, {
      event_type: 'result.submitted', actor_id: 'a', submitted_by: 'a',
      idempotency_key: 'g-late', task_id: t, expected_task_version: 6,
      payload: { summary: 'after the end' },
    }, { now: now() });
    assert.equal(late.ok, false);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'completed');
  });
});

// ---------------------------------------------------------------------------

describe('agent snapshot', () => {
  it('current_task_id null clears the binding instead of preserving it', () => {
    const r1 = appendEvent(db, {
      event_type: 'agent.status_changed', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'snap-1',
      payload: { agent_id: 'chatgpt', context_health: 'normal', work_state: 'working', current_task_id: 'task_007' },
    }, { now: now() });
    assert.equal(r1.ok, true);
    assert.equal(
      db.queryOne('SELECT current_task_id FROM agents WHERE agent_id = ?', ['chatgpt']).current_task_id,
      'task_007');
    const r2 = appendEvent(db, {
      event_type: 'agent.status_changed', actor_id: 'chatgpt', submitted_by: 'chatgpt',
      idempotency_key: 'snap-2',
      payload: { agent_id: 'chatgpt', context_health: 'normal', work_state: 'idle', current_task_id: null },
    }, { now: now() });
    assert.equal(r2.ok, true);
    assert.equal(
      db.queryOne('SELECT current_task_id FROM agents WHERE agent_id = ?', ['chatgpt']).current_task_id,
      null);
  });

  it('rejects a status snapshot missing current_task_id', () => {
    const r = appendEvent(db, {
      event_type: 'agent.status_changed', actor_id: 'x', submitted_by: 'x',
      idempotency_key: 'snap-3',
      payload: { agent_id: 'x', context_health: 'normal', work_state: 'idle' },
    }, { now: now() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'VALIDATION_FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('workspace contention', () => {
  it('six simultaneous status writers all succeed with seqs 1..6', async () => {
    const dbPath = join(tmpdir(), `hub-race-ws-${process.pid}-${Date.now()}.db`);
    const setup = openDb(dbPath);
    applySchema(setup, SCHEMA);
    setup.close();

    const N = 6;
    const run = (i) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./claim-racer.mjs', import.meta.url), {
        workerData: {
          dbPath,
          input: {
            event_type: 'agent.status_changed', actor_id: `agent-${i}`, submitted_by: `agent-${i}`,
            idempotency_key: `ws-race-${i}`,
            payload: { agent_id: `agent-${i}`, context_health: 'normal', work_state: 'working', current_task_id: null },
          },
        },
      });
      w.once('message', resolve);
      w.once('error', reject);
    });
    const results = await Promise.all(Array.from({ length: N }, (_, i) => run(i)));
    assert.ok(results.every((r) => r.ok), `all writers must succeed, got ${JSON.stringify(results)}`);

    const check = openDb(dbPath);
    try {
      assert.equal(check.queryOne('SELECT COUNT(*) c FROM events').c, N);
      const seqs = check.queryAll('SELECT seq FROM events ORDER BY seq', []).map((r) => r.seq);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    } finally {
      check.close();
      rmSync(dbPath, { force: true });
    }
  }, { timeout: 60000 });
});

// ---------------------------------------------------------------------------

describe('from honesty', () => {
  it('rejects task.changed when payload.from disagrees with actual state', () => {
    const c = createTask({ key: 'from-create', task_id: 'task_from' });
    const t = c.event.task_id;
    const lieStatus = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'from-lie1', task_id: t, expected_task_version: 1,
      payload: { field: 'status', from: 'blocked', to: 'claimed', reason: 'lie' },
    }, { now: now() });
    assert.equal(lieStatus.ok, false);
    assert.match(lieStatus.message, /from mismatch/);

    const lieField = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'from-lie2', task_id: t, expected_task_version: 1,
      payload: { field: 'assignee', from: 'nobody', to: 'chatgpt', reason: 'lie' },
    }, { now: now() });
    assert.equal(lieField.ok, false);
    assert.match(lieField.message, /from mismatch/);

    // Honest from (or omitted from) still works.
    const honest = appendEvent(db, {
      event_type: 'task.changed', actor_id: 'm', submitted_by: 'm',
      idempotency_key: 'from-ok', task_id: t, expected_task_version: 1,
      payload: { field: 'assignee', to: 'chatgpt', reason: 'assign' },
    }, { now: now() });
    assert.equal(honest.ok, true);
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 2); // create + honest change
  });
});

// ---------------------------------------------------------------------------

describe('value validation', () => {
  it('returns validation errors, not SQL exceptions, for malformed values', () => {
    const c = createTask({ key: 'val-create', task_id: 'task_val' });
    const t = c.event.task_id;
    const bad = [
      ['task.changed', { field: 'title', to: null }, t],
      ['task.changed', { field: 'title', to: '' }, t],
      ['task.changed', { field: 'priority', to: {} }, t],
      ['task.changed', { field: 'assignee', to: [] }, t],
      ['task.changed', { field: 'deadline', to: {} }, t],
      ['decision.changed', { decision_id: 'x', phase: 'requested', question: 'q', options: 'nope' }, t],
      ['result.submitted', { summary: 's', links: 'https://x' }, t],
      ['handoff.posted', { goal: 'g', agent_id: 'm', references: {} }, null],
      ['task.created', { title: '', goal: 'g' }, null],
    ];
    bad.forEach(([event_type, payload, task_id], i) => {
      const r = appendEvent(db, {
        event_type, actor_id: 'x', submitted_by: 'x',
        idempotency_key: `val-${i}`, task_id, payload,
      }, { now: now() });
      assert.equal(r.ok, false, `${event_type} ${JSON.stringify(payload)} should fail validation`);
      assert.equal(r.code, 'VALIDATION_FAILED');
    });
    // Only the one task.created exists; nothing else was written.
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 1);
  });
});
