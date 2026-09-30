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
let keyTick;
const now = () => nowTick++;
// Every command requires a client-supplied idempotency key (ChatGPT 009
// review): the helper generates a fresh unique key per call unless the test
// passes one explicitly.
const run = (principal, input) =>
  executeCommand(db, principal,
    { idempotency_key: `test-key-${keyTick++}`, ...input }, { now: now() });

beforeEach(() => {
  db = openDb(':memory:');
  applySchema(db, SCHEMA);
  nowTick = 1_700_000_000_000;
  keyTick = 0;
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
    // A state-machine violation: blindly retrying the identical request can
    // never succeed, so it is not retryable (ChatGPT 009 review #5).
    assert.equal(r.retryable, false);
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

    // Completed stays terminal: a late result is rejected as a
    // state-machine violation (INVALID_TRANSITION, not retryable —
    // completed is terminal). (ChatGPT 009 review #5.)
    const late = await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'x' });
    assert.equal(late.code, 'INVALID_TRANSITION');
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
    // requestDecision with a task_id requires the requester's own task.
    await run(chatgpt, { command: 'claimTask', task_id: t });
    const req = await run(chatgpt, {
      command: 'requestDecision', task_id: t, question: 'Ship?', options: ['yes', 'no'],
    });
    assert.equal(req.ok, true);
    const decId = db.queryOne('SELECT decision_id FROM decisions').decision_id;
    assert.match(decId, /^dec_/);
    assert.match(decId, /^dec_[0-9a-f]{32}$/); // full-entropy IDs

    const mRes = await run(mateo, { command: 'resolveDecision', decision_id: decId, resolution: 'yes' });
    assert.equal(mRes.code, 'FORBIDDEN');

    const dRes = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'yes' });
    assert.equal(dRes.ok, true);
    assert.equal(db.queryOne('SELECT phase FROM decisions WHERE decision_id = ?', [decId]).phase, 'resolved');

    // Re-resolving is a state-machine violation, not bad input.
    const again = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'no' });
    assert.equal(again.code, 'INVALID_TRANSITION');
    assert.equal(again.retryable, false);

    const missing = await run(david, { command: 'resolveDecision', decision_id: 'dec_nope', resolution: 'x' });
    assert.equal(missing.code, 'NOT_FOUND');
  });
});

describe('messages, handoffs, artifacts, status', () => {
  it('posts round-trip and the resume packet carries them', async () => {
    const t = await makeTask();
    // Handoffs/artifacts on a task require the poster's own task; town-square
    // messages stay open.
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'postMessage', task_id: t, kind: 'proposal', body: 'Plan A' });
    await run(chatgpt, { command: 'postHandoff', task_id: t, goal: 'Wrap', done: ['a'], pending: ['b'] });
    const art = await run(chatgpt, {
      command: 'attachArtifact', task_id: t, name: 'r.md', uri: 'https://x/r.md', mime_type: 'text/markdown',
    });
    assert.equal(art.ok, true);
    const artId = db.queryOne('SELECT artifact_id FROM artifact_refs').artifact_id;
    assert.match(artId, /^art_[0-9a-f]{32}$/); // full-entropy IDs

    const resume = await getResume(db, t);
    assert.equal(resume.recent_messages.length, 1);
    assert.equal(resume.recent_messages[0].body, 'Plan A');
    assert.equal(resume.artifact_refs.length, 1);
    assert.equal(resume.artifact_refs[0].name, 'r.md');
    // The resume packet carries the latest handoff for context-reset recovery.
    assert.equal(resume.latest_handoff.goal, 'Wrap');
    assert.deepEqual(resume.latest_handoff.done, ['a']);
    assert.deepEqual(resume.latest_handoff.pending, ['b']);
    assert.equal(resume.latest_handoff.agent_id, 'chatgpt');
    assert.equal(resume.status, 'claimed');
    assert.equal(resume.version, 5);
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
      { command: 'claimTask', task_id: t, idempotency_key: 'loser-claim' }, { now: now() });
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
      { command: 'claimTask', task_id: t, idempotency_key: 'winner-claim' }, { now: now() });
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
// ChatGPT 009 review regression tests — appended for the 009 follow-up pass.

describe('ChatGPT 009 review fixes', () => {
  it('idempotency_key is required on every mutating command', async () => {
    const r = await executeCommand(db, mateo,
      { command: 'createTask', title: 'T', goal: 'G' }, { now: now() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.match(r.message, /idempotency_key is required/);
    // Nothing was written.
    assert.equal(db.queryOne('SELECT COUNT(*) c FROM events').c, 0);
  });

  it('a retried claimTask with the same key replays the original event', async () => {
    const t = await makeTask();
    const first = await run(chatgpt, { command: 'claimTask', task_id: t, idempotency_key: 'claim-k1' });
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    // Without the command-level preflight, the builder would see the task
    // already assigned and return TASK_ALREADY_CLAIMED — the exact failure
    // ChatGPT flagged (problem B).
    const retry = await run(chatgpt, { command: 'claimTask', task_id: t, idempotency_key: 'claim-k1' });
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(retry.event_id, first.event_id);
    assert.equal(retry.seq, first.seq);
    // No duplicate claim event was written.
    assert.equal(
      db.queryOne("SELECT COUNT(*) c FROM events WHERE event_type = 'task.changed' AND actor_id = 'chatgpt'").c, 1);
  });

  it('a retried resolveDecision with the same key replays the original event', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    const req = await run(chatgpt, { command: 'requestDecision', task_id: t, question: 'Ship?' });
    assert.equal(req.ok, true);
    const decId = db.queryOne('SELECT decision_id FROM decisions').decision_id;
    const first = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'yes', idempotency_key: 'res-k1' });
    assert.equal(first.ok, true);
    // Without the preflight, the builder would see phase=resolved and return
    // INVALID_TRANSITION — event-core idempotency would never run.
    const retry = await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'yes', idempotency_key: 'res-k1' });
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(retry.event_id, first.event_id);
    assert.equal(
      db.queryOne("SELECT COUNT(*) c FROM events WHERE event_type = 'decision.changed'").c, 2);
  });

  it('server-generated IDs use full UUID entropy', async () => {
    const r = await run(mateo, { command: 'createTask', title: 'T', goal: 'G' });
    assert.equal(r.ok, true);
    assert.match(r.task_id, /^task_[0-9a-f]{32}$/);
    const req = await run(mateo, { command: 'requestDecision', question: 'Q?' });
    assert.equal(req.ok, true);
    assert.match(db.queryOne('SELECT decision_id FROM decisions').decision_id, /^dec_[0-9a-f]{32}$/);
  });

  it('ordinary agents may only claim pending tasks; Mateo may claim blocked work', async () => {
    // Construct an unassigned, blocked task directly through the core
    // (no command path un-assigns a task — this is defense in depth).
    const t = 'task_orphan_blocked';
    const c = await appendEvent(db, {
      event_type: 'task.created', task_id: t, actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'orphan-c', payload: { title: 'T', goal: 'G' },
    }, { now: now() });
    assert.equal(c.ok, true);
    const b = await appendEvent(db, {
      event_type: 'task.changed', task_id: t, actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'orphan-b',
      payload: { field: 'status', from: 'pending', to: 'blocked', reason: 'x' },
    }, { now: now() });
    assert.equal(b.ok, true);

    const gpt = await run(chatgpt, { command: 'claimTask', task_id: t });
    assert.equal(gpt.ok, false);
    assert.equal(gpt.code, 'FORBIDDEN');
    assert.match(gpt.message, /only available on pending tasks/);

    // The coordinator keeps the flexibility to pick up blocked work.
    const m = await run(mateo, { command: 'claimTask', task_id: t });
    assert.equal(m.ok, true);
  });

  it('town-square split: messages are open; handoffs/artifacts/decisions need ownership', async () => {
    const t = await makeTask();
    await run(mateo, { command: 'claimTask', task_id: t });

    // postMessage on somebody else's task: allowed (town square).
    const msg = await run(chatgpt, { command: 'postMessage', task_id: t, kind: 'message', body: 'hey' });
    assert.equal(msg.ok, true);

    // postHandoff / attachArtifact / requestDecision on somebody else's
    // task: operational state, not discussion — forbidden.
    const ho = await run(chatgpt, { command: 'postHandoff', task_id: t, goal: 'g' });
    assert.equal(ho.code, 'FORBIDDEN');
    const art = await run(chatgpt, { command: 'attachArtifact', task_id: t, name: 'n', uri: 'https://x/n' });
    assert.equal(art.code, 'FORBIDDEN');
    const dec = await run(chatgpt, { command: 'requestDecision', task_id: t, question: 'Q?' });
    assert.equal(dec.code, 'FORBIDDEN');

    // Task-less writes are the agent's own operational state: allowed.
    assert.equal((await run(chatgpt, { command: 'postHandoff', goal: 'g' })).ok, true);
    assert.equal((await run(chatgpt, { command: 'attachArtifact', name: 'n', uri: 'https://x/n' })).ok, true);
    assert.equal((await run(chatgpt, { command: 'requestDecision', question: 'Q?' })).ok, true);

    // The owner keeps full access to its own task.
    const own = await makeTask('task_own1');
    await run(chatgpt, { command: 'claimTask', task_id: own });
    assert.equal((await run(chatgpt, { command: 'postHandoff', task_id: own, goal: 'g' })).ok, true);
    assert.equal((await run(chatgpt, { command: 'attachArtifact', task_id: own, name: 'n', uri: 'https://x/n' })).ok, true);
    assert.equal((await run(chatgpt, { command: 'requestDecision', task_id: own, question: 'Q?' })).ok, true);
  });

  it('recordReview links to the current result, ignoring caller input', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'startTask', task_id: t });
    const sub = await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'Done' });
    assert.equal(sub.ok, true);
    // A stale/mistaken caller-supplied event id must not corrupt the trail.
    const rev = await run(mateo, {
      command: 'recordReview', task_id: t, outcome: 'accepted', caused_by_event_id: 'evt_stale_bogus',
    });
    assert.equal(rev.ok, true);
    const row = db.queryOne("SELECT caused_by_event_id FROM events WHERE event_type = 'review.recorded'");
    assert.equal(row.caused_by_event_id, sub.event_id);
  });

  it('links and artifact URIs must be https: URLs', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'startTask', task_id: t });

    const badLink = await run(chatgpt, {
      command: 'submitResult', task_id: t, summary: 'x', links: ['http://example.com/x'],
    });
    assert.equal(badLink.code, 'VALIDATION_FAILED');
    const notUrl = await run(chatgpt, {
      command: 'submitResult', task_id: t, summary: 'x', links: ['not a url'],
    });
    assert.equal(notUrl.code, 'VALIDATION_FAILED');
    const good = await run(chatgpt, {
      command: 'submitResult', task_id: t, summary: 'x', links: ['https://example.com/x'],
    });
    assert.equal(good.ok, true);

    const badUri = await run(mateo, { command: 'attachArtifact', name: 'n', uri: 'http://x/n' });
    assert.equal(badUri.code, 'VALIDATION_FAILED');
  });

  it('state-machine violations map to INVALID_TRANSITION and are not retryable', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'startTask', task_id: t });
    // Review while not under-review: the JSON is fine, the state forbids it.
    const r1 = await run(mateo, { command: 'recordReview', task_id: t, outcome: 'accepted' });
    assert.equal(r1.code, 'INVALID_TRANSITION');
    assert.equal(r1.retryable, false);

    // Drive the task to completed, then startTask from a terminal state.
    await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'x' });
    await run(mateo, { command: 'recordReview', task_id: t, outcome: 'accepted' });
    const r2 = await run(chatgpt, { command: 'startTask', task_id: t });
    assert.equal(r2.code, 'INVALID_TRANSITION');
    assert.equal(r2.retryable, false);
  });

  it('PROJECTION_CONFLICT uses a stable client message, not raw DB text', async () => {
    await run(mateo, { command: 'createTask', task_id: 'task_dup9', title: 'T', goal: 'G' });
    const r = await run(mateo, {
      command: 'createTask', task_id: 'task_dup9', title: 'T2', goal: 'G2',
      idempotency_key: 'dup-key-different',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROJECTION_CONFLICT');
    assert.equal(r.message, 'the command conflicted with existing projected state');
    assert.equal(r.retryable, false);
  });

  it('resume carries resolved decisions, the latest handoff, and a durable blocked reason', async () => {
    const t = await makeTask('task_resume9');
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, {
      command: 'postHandoff', task_id: t, goal: 'Wrap up', done: ['a'], pending: ['b'], key_context: 'ctx',
    });
    const req = await run(chatgpt, { command: 'requestDecision', task_id: t, question: 'Ship?' });
    assert.equal(req.ok, true);
    const decId = db.queryOne('SELECT decision_id FROM decisions WHERE task_id = ?', [t]).decision_id;
    await run(david, { command: 'resolveDecision', decision_id: decId, resolution: 'yes, ship it' });

    // Block the task, then change something unrelated (priority) directly —
    // the blocked reason must survive the later non-status event.
    await run(chatgpt, { command: 'startTask', task_id: t });
    const blk = await run(chatgpt, { command: 'blockTask', task_id: t, reason: 'waiting on David' });
    assert.equal(blk.ok, true);
    const pri = await appendEvent(db, {
      event_type: 'task.changed', task_id: t, actor_id: 'mateo', submitted_by: 'mateo',
      idempotency_key: 'pri-9', payload: { field: 'priority', from: 'normal', to: 'high' },
    }, { now: now() });
    assert.equal(pri.ok, true);

    const resume = await getResume(db, t);
    assert.equal(resume.blocked_reason, 'waiting on David');
    assert.equal(resume.open_decisions.length, 0);
    assert.equal(resume.resolved_decisions.length, 1);
    assert.equal(resume.resolved_decisions[0].decision_id, decId);
    assert.equal(resume.resolved_decisions[0].resolution, 'yes, ship it');
    assert.equal(resume.latest_handoff.goal, 'Wrap up');
    assert.equal(resume.latest_handoff.agent_id, 'chatgpt');
    assert.deepEqual(resume.latest_handoff.done, ['a']);
    assert.deepEqual(resume.latest_handoff.pending, ['b']);
    assert.equal(resume.latest_handoff.key_context, 'ctx');
  });
});

describe('ChatGPT 009 re-review: boundary validation is complete', () => {
  // Every case: malformed input must return 400 VALIDATION_FAILED and must
  // not write an event. The core's VALIDATION_FAILED is therefore reserved
  // for state-dependent rejections, which map to INVALID_TRANSITION.
  const eventCount = () => db.queryOne('SELECT COUNT(*) c FROM events').c;

  async function inProgressTask() {
    const t = await makeTask(`task_bnd_${keyTick}`);
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'startTask', task_id: t });
    return t;
  }

  it('postMessage kind="banana" is rejected without writing', async () => {
    const t = await makeTask();
    const before = eventCount();
    const r = await run(chatgpt, { command: 'postMessage', task_id: t, kind: 'banana', body: 'hello' });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('postMessage rejects a malformed reply_to', async () => {
    const t = await makeTask();
    const before = eventCount();
    const r = await run(chatgpt, { command: 'postMessage', task_id: t, body: 'hi', reply_to: 42 });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('postMessage still accepts every valid kind', async () => {
    const t = await makeTask();
    for (const kind of ['message', 'question', 'proposal']) {
      const r = await run(chatgpt, { command: 'postMessage', task_id: t, kind, body: 'b' });
      assert.equal(r.ok, true, kind);
    }
    // Omitted kind defaults to message.
    const d = await run(chatgpt, { command: 'postMessage', task_id: t, body: 'b' });
    assert.equal(d.ok, true);
  });

  it('requestDecision options="yes" is rejected without writing', async () => {
    const before = eventCount();
    const r = await run(chatgpt, { command: 'requestDecision', question: 'Ship?', options: 'yes' });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('submitResult evidence must be an object, not an array', async () => {
    const t = await inProgressTask();
    const before = eventCount();
    const r = await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'done', evidence: ['not', 'an', 'object'] });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
    // A well-formed evidence object passes.
    const ok = await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'done', evidence: { files: 3 } });
    assert.equal(ok.ok, true);
  });

  it('recordReview rejects non-string notes', async () => {
    const t = await inProgressTask();
    await run(chatgpt, { command: 'submitResult', task_id: t, summary: 'done' });
    const before = eventCount();
    const r = await run(mateo, { command: 'recordReview', task_id: t, outcome: 'accepted', notes: 42 });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('postHandoff validates done/pending/references arrays and string fields', async () => {
    for (const bad of [{ done: 'done' }, { pending: 'p' }, { references: 'r' },
                       { key_context: 7 }, { reason: ['x'] }]) {
      const before = eventCount();
      const r = await run(chatgpt, { command: 'postHandoff', goal: 'g', ...bad });
      assert.equal(r.code, 'VALIDATION_FAILED', JSON.stringify(bad));
      assert.equal(eventCount(), before);
    }
    // Well-formed handoff passes.
    const ok = await run(chatgpt, {
      command: 'postHandoff', goal: 'g', done: ['a'], pending: ['b'],
      key_context: 'ctx', reason: 'shift', references: ['https://x'],
    });
    assert.equal(ok.ok, true);
  });

  it('setAgentStatus validates the health and work-state enums', async () => {
    for (const bad of [{ context_health: 'great' }, { work_state: 'sleeping' },
                       { context_health: 'excellent' }, { work_state: '' }]) {
      const before = eventCount();
      const r = await run(chatgpt, {
        command: 'setAgentStatus', ...bad,
        context_health: bad.context_health ?? 'normal',
        work_state: bad.work_state ?? 'working',
        current_task_id: null,
      });
      assert.equal(r.code, 'VALIDATION_FAILED', JSON.stringify(bad));
      assert.equal(eventCount(), before);
    }
    // Every valid enum combination passes.
    for (const h of ['normal', 'watch', 'handoff-due']) {
      for (const w of ['idle', 'working', 'blocked', 'stalled']) {
        const r = await run(chatgpt, {
          command: 'setAgentStatus', context_health: h, work_state: w, current_task_id: null,
        });
        assert.equal(r.ok, true, `${h}/${w}`);
      }
    }
  });

  it('setAgentStatus validates current_task_id shape', async () => {
    const before = eventCount();
    const r = await run(chatgpt, {
      command: 'setAgentStatus', context_health: 'normal', work_state: 'working',
      current_task_id: 42,
    });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('attachArtifact validates mime_type and sha256', async () => {
    for (const bad of [{ mime_type: {} }, { sha256: ['abc'] }, { mime_type: 5 }]) {
      const before = eventCount();
      const r = await run(chatgpt, {
        command: 'attachArtifact', name: 'n', uri: 'https://x/n', ...bad,
      });
      assert.equal(r.code, 'VALIDATION_FAILED', JSON.stringify(bad));
      assert.equal(eventCount(), before);
    }
    const ok = await run(chatgpt, {
      command: 'attachArtifact', name: 'n', uri: 'https://x/n',
      mime_type: 'text/plain', sha256: 'abc123',
    });
    assert.equal(ok.ok, true);
  });

  it('createTask rejects malformed priority and task_id instead of silently defaulting', async () => {
    const before = eventCount();
    const p = await run(mateo, { command: 'createTask', title: 'T', goal: 'G', priority: { bad: true } });
    assert.equal(p.code, 'VALIDATION_FAILED');
    const t = await run(mateo, { command: 'createTask', title: 'T', goal: 'G', task_id: 42 });
    assert.equal(t.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
    // A valid string priority still passes.
    const ok = await run(mateo, { command: 'createTask', title: 'T', goal: 'G', priority: 'high' });
    assert.equal(ok.ok, true);
  });

  it('expected_task_version must be a non-negative integer', async () => {
    const t = await makeTask();
    const before = eventCount();
    const r = await run(chatgpt, {
      command: 'claimTask', task_id: t, expected_task_version: '1',
    });
    assert.equal(r.code, 'VALIDATION_FAILED');
    assert.equal(eventCount(), before);
  });

  it('blocked reason survives more than 50 later non-status events', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    await run(chatgpt, { command: 'startTask', task_id: t });
    const blk = await run(chatgpt, { command: 'blockTask', task_id: t, reason: 'waiting on David' });
    assert.equal(blk.ok, true);
    // Bury the block under 60 priority-change events, far past the old
    // LIMIT 50 scan bound.
    let pri = 'normal';
    for (let i = 0; i < 60; i++) {
      const next = pri === 'normal' ? 'high' : 'normal';
      const r = await appendEvent(db, {
        event_type: 'task.changed', task_id: t, actor_id: 'mateo', submitted_by: 'mateo',
        idempotency_key: `pri-bury-${i}`, payload: { field: 'priority', from: pri, to: next },
      }, { now: now() });
      assert.equal(r.ok, true);
      pri = next;
    }
    const resume = await getResume(db, t);
    assert.equal(resume.blocked_reason, 'waiting on David');
  });
});

describe('ChatGPT 009 final re-review: optional task_id presence semantics', () => {
  // undefined/null → workspace scope; non-empty string → task scope;
  // anything else ("" , 0, false) → 400 VALIDATION_FAILED, no event.
  const eventCount = () => db.queryOne('SELECT COUNT(*) c FROM events').c;

  it('empty-string task_id is rejected, not treated as workspace scope', async () => {
    for (const input of [
      { command: 'requestDecision', task_id: '', question: 'Q?' },
      { command: 'postHandoff', task_id: '', goal: 'g' },
      { command: 'attachArtifact', task_id: '', name: 'n', uri: 'https://x/n' },
    ]) {
      const before = eventCount();
      const r = await executeCommand(db, chatgpt,
        { idempotency_key: `tid-${before}`, ...input }, { now: now() });
      assert.equal(r.code, 'VALIDATION_FAILED', JSON.stringify(input));
      assert.equal(eventCount(), before);
    }
    // Falsy non-strings are rejected too.
    for (const bad of [0, false]) {
      const before = eventCount();
      const r = await executeCommand(db, chatgpt,
        { idempotency_key: `tidb-${before}-${bad}`, command: 'requestDecision', task_id: bad, question: 'Q?' },
        { now: now() });
      assert.equal(r.code, 'VALIDATION_FAILED');
      assert.equal(eventCount(), before);
    }
  });

  it('omitted or null task_id still writes intentional workspace-level events', async () => {
    const d = await run(chatgpt, { command: 'requestDecision', question: 'Q?' });
    assert.equal(d.ok, true);
    assert.equal(d.task_id, null);
    const n = await run(chatgpt, { command: 'postHandoff', task_id: null, goal: 'g' });
    assert.equal(n.ok, true);
    assert.equal(n.task_id, null);
    const a = await run(chatgpt, { command: 'attachArtifact', name: 'n', uri: 'https://x/n' });
    assert.equal(a.ok, true);
    assert.equal(a.task_id, null);
  });

  it('a real task_id still scopes to the task', async () => {
    const t = await makeTask();
    await run(chatgpt, { command: 'claimTask', task_id: t });
    const d = await run(chatgpt, { command: 'requestDecision', task_id: t, question: 'Q?' });
    assert.equal(d.ok, true);
    assert.equal(d.task_id, t);
    assert.equal(db.queryOne('SELECT task_id FROM decisions').task_id, t);
  });
});
