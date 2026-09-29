// commands.test.mjs — task 009 command-layer tests.
// Exercises executeCommand() directly against node:sqlite, plus the
// rate limiter. HTTP mapping is covered in routes.test.mjs.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, applySchema } from '../src/sqlite-db.mjs';
import { executeCommand, COMMANDS } from '../src/commands.mjs';
import { appendEvent } from '../src/event-core.mjs';
import { createRateLimiter } from '../src/rate-limit.mjs';
import { getResume } from '../src/queries.mjs';

const SCHEMA = readFileSync(new URL('../../db/migrations/0001_schema.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../../db/migrations/0002_auth.sql', import.meta.url), 'utf8');

const david = { kind: 'david' };
const mateo = { kind: 'agent', agent_id: 'mateo', role: 'mateo' };
const chatgpt = { kind: 'agent', agent_id: 'chatgpt', role: 'agent' };
const codex = { kind: 'agent', agent_id: 'codex', role: 'agent' };

let db;
let nowTick;
const now = () => nowTick++;
const run = (principal, input) => executeCommand(db, principal, input, { now: now() });

beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  nowTick = 1_700_000_000_000;
});
afterEach(() => { db.close(); });

async function makeTask(task_id = 'task_cmd1') {
  const r = await run(mateo, { command: 'createTask', task_id, title: 'T', goal: 'G' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return task_id;
}

describe('command surface', () => {
  it('exposes exactly the 12 specified commands', () => {
    assert.deepEqual([...COMMANDS].sort(), [
      'attachArtifact', 'blockTask', 'claimTask', 'createTask', 'postHandoff',
      'postMessage', 'recordReview', 'requestDecision', 'resolveDecision',
      'setAgentStatus', 'startTask', 'submitResult',
    ].sort());
  });

  it('rejects unknown and missing commands without writing', async () => {
    assert.equal((await run(mateo, { command: 'nukeTask' })).code, 'VALIDATION_FAILED');
    assert.equal((await run(mateo, {})).code, 'VALIDATION_FAILED');
    assert.equal((await run(mateo, null)).code, 'VALIDATION_FAILED');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 0);
  });

  it('requires authentication', async () => {
    const r = await run(null, { command: 'createTask', title: 'T', goal: 'G' });
    assert.equal(r.code, 'AUTH_REQUIRED');
  });
});

describe('createTask', () => {
  it('mateo creates; david creates; ordinary agent is forbidden', async () => {
    const r = await run(mateo, { command: 'createTask', task_id: 't1', title: 'Title', goal: 'Goal', priority: 'high' });
    assert.equal(r.ok, true);
    assert.equal(r.event_type, 'task.created');
    assert.equal(r.task_id, 't1');
    assert.equal(r.seq, 1);
    assert.equal(r.version, 1);
    assert.ok(r.idempotency_key);
    const row = db.queryOne('SELECT status, priority, created_by FROM tasks WHERE task_id = ?', ['t1']);
    assert.equal(row.status, 'pending');
    assert.equal(row.priority, 'high');
    assert.equal(row.created_by, 'mateo');

    const d = await run(david, { command: 'createTask', task_id: 't2', title: 'T', goal: 'G' });
    assert.equal(d.ok, true);

    const f = await run(chatgpt, { command: 'createTask', title: 'T', goal: 'G' });
    assert.equal(f.code, 'FORBIDDEN');
  });

  it('generates a task_id when omitted', async () => {
    const r = await run(mateo, { command: 'createTask', title: 'T', goal: 'G' });
    assert.equal(r.ok, true);
    assert.match(r.task_id, /^task_/);
  });

  it('missing title writes nothing', async () => {
    const r = await run(mateo, { command: 'createTask', goal: 'G' });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 0);
  });
});

describe('claim / start / block', () => {
  it('agent self-claims an unassigned task; a rival claim fails closed', async () => {
    const t = await makeTask();
    const c1 = await run(chatgpt, { command: 'claimTask', task_id: t });
    assert.equal(c1.ok, true);
    assert.equal(c1.event_type, 'task.changed');
    assert.equal(db.queryOne('SELECT assignee FROM tasks WHERE task_id = ?', [t]).assignee, 'chatgpt');

    const c2 = await run(codex, { command: 'claimTask', task_id: t });
    assert.equal(c2.code, 'TASK_ALREADY_CLAIMED');
    assert.equal(c2.current_task_version, 2);
    assert.equal(db.queryOne('SELECT assignee FROM tasks WHERE task_id = ?', [t]).assignee, 'chatgpt');
  });

  it('an agent cannot claim a task for someone else', async () => {
    const t = await makeTask();
    const r = await run(chatgpt, { command: 'claimTask', task_id: t, assignee: 'codex' });
    assert.equal(r.code, 'FORBIDDEN');
  });

  it('mateo may claim on behalf of another agent', async () => {
    const t = await makeTask();
    const r = await run(mateo, { command: 'claimTask', task_id: t, assignee: 'chatgpt' });
    assert.equal(r.ok, true);
    assert.equal(db.queryOne('SELECT assignee FROM tasks WHERE task_id = ?', [t]).assignee, 'chatgpt');
  });

  it('agents start and block only their own tasks', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    const other = await run(codex, { command: 'startTask', task_id: t });
    assert.equal(other.code, 'FORBIDDEN');

    const s = await run(chatgpt, { command: 'startTask', task_id: t });
    assert.equal(s.ok, true);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'in-progress');

    const b = await run(chatgpt, { command: 'blockTask', task_id: t, reason: 'waiting on david' });
    assert.equal(b.ok, true);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'blocked');
  });

  it('illegal status jumps surface as INVALID_TRANSITION', async () => {
    const t = await makeTask(); // pending
    const r = await run(mateo, { command: 'startTask', task_id: t }); // pending -> in-progress illegal
    assert.equal(r.code, 'INVALID_TRANSITION');
    assert.equal(r.retryable, true);
  });
});

describe('result -> review lifecycle', () => {
  async function toInProgress(t, agent = chatgpt) {
    await run(agent, { command: 'claimTask', task_id: t });
    await run(agent, { command: 'startTask', task_id: t });
  }

  it('submitResult then accepted review completes the task atomically', async () => {
    const t = await makeTask();
    await toInProgress(t);
    const sub = await run(chatgpt, {
      command: 'submitResult', task_id: t,
      summary: 'Done', evidence: { tests: '9/9' }, links: ['https://example.com/x'],
    });
    assert.equal(sub.ok, true);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'under-review');

    // An ordinary agent may not record reviews.
    const fr = await run(chatgpt, { command: 'recordReview', task_id: t, outcome: 'accepted' });
    assert.equal(fr.code, 'FORBIDDEN');

    const rev = await run(mateo, {
      command: 'recordReview', task_id: t, outcome: 'accepted', notes: 'Solid',
      caused_by_event_id: sub.event_id,
    });
    assert.equal(rev.ok, true);
    // One command, one event — the projection derived the completion.
    const row = db.queryOne('SELECT status, version FROM tasks WHERE task_id = ?', [t]);
    assert.equal(row.status, 'completed');
    assert.equal(row.version, rev.seq);

    // Completed stays terminal: a late result is rejected as invalid
    // against current state (not retryable — completed is terminal).
    const late = await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'x' });
    assert.equal(late.code, 'VALIDATION_FAILED');
    assert.equal(late.retryable, false);
  });

  it('rework sends the task back to in-progress', async () => {
    const t = await makeTask();
    await toInProgress(t);
    await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'Done' });
    const rev = await run(mateo, { command: 'recordReview', task_id: t, outcome: 'rework', notes: 'again' });
    assert.equal(rev.ok, true);
    assert.equal(db.queryOne('SELECT status FROM tasks WHERE task_id = ?', [t]).status, 'in-progress');
  });

  it('submitResult requires a summary and writes nothing when invalid', async () => {
    const t = await makeTask();
    await toInProgress(t);
    const before = db.queryOne('SELECT COUNT(*) c FROM events').c;
    const r = await run(chatgpt, { command: 'submitResult', task_id: t });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, before);
  });

  it('stale expected_task_version returns VERSION_CONFLICT with the live version', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    const r = await run(chatgpt, { command: 'startTask', task_id: t, expected_task_version: 1 });
    assert.equal(r.code, 'VERSION_CONFLICT');
    assert.equal(r.retryable, true);
    assert.equal(r.current_task_version, 2);
  });
});

describe('decisions', () => {
  it('anyone may request; only David may resolve', async () => {
    const t = await makeTask();
    const req = await run(chatgpt, {
      command: 'requestDecision', task_id: t, question: 'Ship?', options: ['yes', 'no'],
    });
    assert.equal(req.ok, true);
    const decId = db.queryOne('SELECT decision_id FROM decisions').decision_id;
    assert.match(decId, /^dec_/);

    const mRes = await run(mateo, { command: 'resolveDecision', decision_id: decId, resolution: 'yes' });
    assert.equal(mRes.code, 'FORBIDDEN');

    const dRes = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'yes' });
    assert.equal(dRes.ok, true);
    assert.equal(db.queryOne('SELECT phase FROM decisions WHERE decision_id = ?', [decId]).phase, 'resolved');

    const again = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'no' });
    assert.equal(again.code, 'VALIDATION_FAILED');

    const missing = await run(david, { command: 'resolveDecision', decision_id: 'dec_nope', resolution: 'x' });
    assert.equal(missing.code, 'NOT_FOUND');
  });
});

describe('messages, handoffs, artifacts, status', () => {
  it('posts round-trip and the resume packet carries them', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'postMessage', task_id: t, kind: 'proposal', body: 'Plan A' });
    await run(chatgpt, { command: 'postHandoff', task_id: t, goal: 'Wrap', done: ['a'], pending: ['b'] });
    const art = await run(chatgpt, {
      command: 'attachArtifact', task_id: t, name: 'r.md', uri: 'https://x/r.md', mime_type: 'text/markdown',
    });
    assert.equal(art.ok, true);
    const artId = db.queryOne('SELECT artifact_id FROM artifact_refs').artifact_id;
    assert.match(artId, /^art_/);

    const resume = await getResume(db, t);
    assert.equal(resume.recent_messages.length, 1);
    assert.equal(resume.recent_messages[0].body, 'Plan A');
    assert.equal(resume.artifact_refs.length, 1);
    assert.equal(resume.artifact_refs[0].name, 'r.md');
    assert.equal(resume.status, 'pending');
    assert.equal(resume.version, 4);
  });

  it('setAgentStatus forces ordinary agents to their own identity', async () => {
    const r = await run(chatgpt, {
      command: 'setAgentStatus', agent_id: 'mateo',
      context_health: 'watch', work_state: 'working', current_task_id: null,
    });
    assert.equal(r.ok, true);
    const row = db.queryOne('SELECT * FROM agents WHERE agent_id = ?', ['chatgpt']);
    assert.equal(row.context_health, 'watch');
    assert.equal(row.work_state, 'working');
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM agents WHERE agent_id = ?', ['mateo']).c, 0);
  });

  it('caller-supplied actor_id/submitted_by are discarded', async () => {
    const r = await run(mateo, {
      command: 'createTask', title: 'T', goal: 'G', task_id: 't_spoof',
      actor_id: 'david', submitted_by: 'david',
    });
    assert.equal(r.ok, true);
    const ev = db.queryOne('SELECT actor_id, submitted_by FROM events WHERE event_id = ?', [r.event_id]);
    assert.equal(ev.actor_id, 'mateo');
    assert.equal(ev.submitted_by, 'mateo');
  });
});

describe('idempotency', () => {
  it('repeating a command with the same key replays the original event', async () => {
    const first = await run(mateo, {
      command: 'createTask', task_id: 't_idem', title: 'T', goal: 'G', idempotency_key: 'k-1',
    });
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    const second = await run(mateo, {
      command: 'createTask', task_id: 't_idem', title: 'T', goal: 'G', idempotency_key: 'k-1',
    });
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.event_id, first.event_id);
    assert.equal(db.queryOne("SELECT COUNT(*) c FROM events WHERE event_type = 'task.created'").c, 1);
  });
});

describe('claim races', () => {
  it('a lost seq race against a rival claim fails closed as TASK_ALREADY_CLAIMED', async () => {
    const t = await makeTask();
    const realBatch = db.batch.bind(db);
    let raced = false;
    // Between the command's validation and its write, a rival commits a
    // claim — the command's batch then genuinely conflicts on (task_id, seq)
    // and must retry into the rival's newer state.
    const racingDb = {
      ...db,
      batch: async (stmts) => {
        if (!raced) {
          raced = true;
          const rival = await appendEvent(db, {
            event_type: 'task.changed', task_id: t,
            actor_id: 'codex', submitted_by: 'codex',
            idempotency_key: 'rival-claim',
            payload: { field: 'assignee', from: null, to: 'codex' },
          }, { now: now() });
          assert.equal(rival.ok, true);
        }
        return realBatch(stmts);
      },
    };
    const r = await executeCommand(racingDb, chatgpt,
      { command: 'claimTask', task_id: t }, { now: now() });
    assert.equal(r.code, 'TASK_ALREADY_CLAIMED');
    assert.equal(r.retryable, false);
    assert.equal(r.conflicting_assignee, 'codex');
    // The loser's event was never written.
    assert.equal(
      db.queryOne("SELECT COUNT(*) c FROM events WHERE actor_id = 'chatgpt'").c, 0);
  });

  it('a transient seq conflict retries and succeeds', async () => {
    const t = await makeTask();
    const realBatch = db.batch.bind(db);
    let raced = false;
    // A rival commits an UNRELATED change (priority) between the command's
    // validation and its write. The claim's batch genuinely conflicts on
    // (task_id, seq); the retry revalidates against the newer state — the
    // task is still unassigned — and the claim commits.
    const racingDb = {
      ...db,
      batch: async (stmts) => {
        if (!raced) {
          raced = true;
          const rival = await appendEvent(db, {
            event_type: 'task.changed', task_id: t,
            actor_id: 'mateo', submitted_by: 'mateo',
            idempotency_key: 'rival-priority',
            payload: { field: 'priority', from: 'normal', to: 'high' },
          }, { now: now() });
          assert.equal(rival.ok, true);
        }
        return realBatch(stmts);
      },
    };
    const r = await executeCommand(racingDb, chatgpt,
      { command: 'claimTask', task_id: t }, { now: now() });
    assert.equal(r.ok, true);
    const row = db.queryOne('SELECT assignee, priority, version FROM tasks WHERE task_id = ?', [t]);
    assert.equal(row.assignee, 'chatgpt');
    assert.equal(row.priority, 'high');
    assert.equal(row.version, r.seq);
  });
});

describe('rate limiter', () => {
  it('allows the budget then blocks with a retry hint', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000 });
    assert.equal(rl.check('k', 1000).ok, true);
    assert.equal(rl.check('k', 1000).ok, true);
    const blocked = rl.check('k', 1000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.retryAfterMs, 60_000);
    // A new window resets the budget.
    assert.equal(rl.check('k', 61_001).ok, true);
    // Other keys are unaffected.
    assert.equal(rl.check('other', 1000).ok, true);
  });
});
