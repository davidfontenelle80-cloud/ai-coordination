// event-core.mjs — hub v1 internal event core (task 007)
//
// This module is the ONLY writer of the `events` table and the ONLY mutator
// of projection tables. It is internal: the public surface will be domain
// commands (task 009); command handlers call appendEvent() and never touch
// events/projections directly.
//
// Db interface (implemented by sqlite-db.mjs locally, D1 adapter at deploy):
//   queryOne(sql, params) -> row | undefined
//   queryAll(sql, params) -> row[]
//   batch([{sql, params}]) -> executes ALL statements atomically; throws on
//                             constraint violation (single linearization point)
//
// Concurrency model (D1-compatible):
//   * Static validation, then the idempotency lookup — BEFORE any
//     state-dependent validation, so retries of committed commands replay
//     instead of failing against moved-on state.
//   * Read phase (per attempt): current version read, stale expected version
//     -> VERSION_CONFLICT, then state-dependent validation against the
//     freshly-read state. A retry after a lost race revalidates; it never
//     commits against assumptions a rival commit invalidated.
//   * Write phase: ONE atomic batch [INSERT event, projection statements].
//   * The UNIQUE(COALESCE(task_id,''), seq) constraint makes the batch fail
//     atomically when a concurrent writer committed first. On failure we
//     re-check idempotency (retry of the same command -> return existing),
//     then classify: sequence advanced -> genuine race, retry (bounded);
//     sequence did not advance -> PROJECTION_CONFLICT, surfaced, not retried.
//     Stale expected_task_version -> VERSION_CONFLICT.
//   * Invariant: tasks.version == seq of the last task-scoped event.
//
// Derived transitions (FORMAL semantics — do not "simplify" these into
// separate writes; ChatGPT 009 review #1 accepted the one-event design):
//   * One command appends exactly ONE domain event. Compound lifecycle
//     transitions are derived deterministically by the projections from
//     that single event's payload, never committed as separate events.
//     This makes crash-between-events impossible by construction:
//       task.changed(field=assignee)  -> projection derives pending -> claimed
//       result.submitted              -> projection derives in-progress -> under-review
//       review.recorded(outcome=accepted) -> projection derives under-review -> completed
//       review.recorded(outcome=rework)   -> projection derives under-review -> in-progress
//   * The event payload contains everything needed to reproduce the derived
//     status; replays must reproduce the identical projection state.

// Web Crypto is native in both Workers and node 22 — no node: import needed.
const randomUUID = () => crypto.randomUUID();

export const SCHEMA_VERSION = 1;

export const EVENT_TYPES = [
  'task.created',
  'task.changed',
  'message.posted',
  'result.submitted',
  'review.recorded',
  'decision.changed',
  'handoff.posted',
  'artifact.attached',
  'agent.status_changed',
];

export const TASK_STATUSES = [
  'pending', 'claimed', 'in-progress', 'under-review', 'completed', 'blocked',
];

// Allowed status transitions. `blocked` may be entered from anywhere and
// returns to an active state; `completed` is terminal.
export const STATUS_TRANSITIONS = {
  'pending':      ['claimed', 'blocked'],
  'claimed':      ['in-progress', 'blocked'],
  'in-progress':  ['under-review', 'blocked'],
  'under-review': ['completed', 'in-progress', 'blocked'],
  'blocked':      ['pending', 'claimed', 'in-progress', 'under-review'],
  'completed':    [],
};

export const TASK_CHANGED_FIELDS = ['status', 'assignee', 'priority', 'deadline', 'title'];
export const CONTEXT_HEALTHS = ['normal', 'watch', 'handoff-due'];
export const WORK_STATES = ['idle', 'working', 'blocked', 'stalled'];
export const MESSAGE_KINDS = ['message', 'question', 'proposal'];
export const REVIEW_OUTCOMES = ['accepted', 'rework'];
export const DECISION_PHASES = ['requested', 'resolved'];

const PROJECTION_TABLES = [
  'messages', 'results', 'reviews', 'handoffs', 'artifact_refs',
  'decisions', 'tasks', 'agents',
];

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function fail(message) {
  return { ok: false, code: 'VALIDATION_FAILED', message };
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validatePayload(eventType, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'payload must be an object';
  switch (eventType) {
    case 'task.created':
      if (!nonEmptyString(p.title)) return 'task.created requires payload.title';
      if (!nonEmptyString(p.goal)) return 'task.created requires payload.goal';
      if (p.priority !== undefined && !nonEmptyString(p.priority)) return 'payload.priority must be a string';
      return null;
    case 'task.changed': {
      if (!TASK_CHANGED_FIELDS.includes(p.field)) return `task.changed field must be one of ${TASK_CHANGED_FIELDS.join(', ')}`;
      if (p.to === undefined) return 'task.changed requires payload.to';
      if (p.field === 'status') {
        if (!TASK_STATUSES.includes(p.to)) return `unknown status ${p.to}`;
      } else if (p.field === 'title' || p.field === 'priority') {
        if (!nonEmptyString(p.to)) return `task.changed ${p.field} requires a non-empty string "to"`;
      } else if (p.field === 'assignee') {
        if (p.to !== null && typeof p.to !== 'string') return 'task.changed assignee "to" must be a string or null';
      } else if (p.field === 'deadline') {
        if (p.to !== null && !nonEmptyString(p.to)) return 'task.changed deadline "to" must be a non-empty string or null';
      }
      return null;
    }
    case 'message.posted':
      if (!MESSAGE_KINDS.includes(p.kind)) return `message.posted kind must be one of ${MESSAGE_KINDS.join(', ')}`;
      if (!nonEmptyString(p.body)) return 'message.posted requires payload.body';
      if (p.reply_to !== undefined && p.reply_to !== null && !nonEmptyString(p.reply_to)) {
        return 'message.posted payload.reply_to must be a non-empty string';
      }
      return null;
    case 'result.submitted':
      if (!nonEmptyString(p.summary)) return 'result.submitted requires payload.summary';
      if (p.links !== undefined && !Array.isArray(p.links)) return 'result.submitted payload.links must be an array';
      if (p.evidence !== undefined && p.evidence !== null &&
          (typeof p.evidence !== 'object' || Array.isArray(p.evidence))) {
        return 'result.submitted payload.evidence must be an object';
      }
      return null;
    case 'review.recorded':
      if (!REVIEW_OUTCOMES.includes(p.outcome)) return `review.recorded outcome must be one of ${REVIEW_OUTCOMES.join(', ')}`;
      if (p.notes !== undefined && p.notes !== null && typeof p.notes !== 'string') {
        return 'review.recorded payload.notes must be a string';
      }
      return null;
    case 'decision.changed':
      // decision_id is required (not generated): projections must be pure
      // functions of the event so rebuilds reproduce identical state.
      if (!nonEmptyString(p.decision_id)) return 'decision.changed requires payload.decision_id';
      if (!DECISION_PHASES.includes(p.phase)) return `decision.changed phase must be one of ${DECISION_PHASES.join(', ')}`;
      if (p.phase === 'requested' && !nonEmptyString(p.question)) return 'decision.changed requested requires payload.question';
      if (p.phase === 'resolved' && !nonEmptyString(p.resolution)) return 'decision.changed resolved requires payload.resolution';
      if (p.options !== undefined && !Array.isArray(p.options)) return 'decision.changed payload.options must be an array';
      return null;
    case 'handoff.posted':
      if (!nonEmptyString(p.goal)) return 'handoff.posted requires payload.goal';
      for (const k of ['done', 'pending', 'references']) {
        if (p[k] !== undefined && !Array.isArray(p[k])) return `handoff.posted payload.${k} must be an array`;
      }
      for (const k of ['key_context', 'agent_id', 'reason']) {
        if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'string') {
          return `handoff.posted payload.${k} must be a string`;
        }
      }
      return null;
    case 'artifact.attached':
      // artifact_id is required (not generated): see decision.changed note.
      if (!nonEmptyString(p.artifact_id)) return 'artifact.attached requires payload.artifact_id';
      if (!nonEmptyString(p.name)) return 'artifact.attached requires payload.name';
      if (!nonEmptyString(p.uri)) return 'artifact.attached requires payload.uri';
      for (const k of ['mime_type', 'sha256', 'supersedes']) {
        if (p[k] !== undefined && p[k] !== null && !nonEmptyString(p[k])) {
          return `artifact.attached payload.${k} must be a non-empty string`;
        }
      }
      return null;
    case 'agent.status_changed':
      if (p.agent_id !== undefined && !nonEmptyString(p.agent_id)) {
        return 'agent.status_changed payload.agent_id must be a non-empty string';
      }
      if (!CONTEXT_HEALTHS.includes(p.context_health)) return `context_health must be one of ${CONTEXT_HEALTHS.join(', ')}`;
      if (!WORK_STATES.includes(p.work_state)) return `work_state must be one of ${WORK_STATES.join(', ')}`;
      // Complete snapshot: callers state the task binding explicitly —
      // null clears it — so replay assigns directly instead of COALESCE.
      if (!('current_task_id' in p)) return 'agent.status_changed requires payload.current_task_id (string or null)';
      if (p.current_task_id !== null && !nonEmptyString(p.current_task_id)) {
        return 'agent.status_changed payload.current_task_id must be a string or null';
      }
      return null;
    default:
      return `unknown event_type ${eventType}`;
  }
}

export function validateEvent(input) {
  if (!input || typeof input !== 'object') return fail('event must be an object');
  if (!EVENT_TYPES.includes(input.event_type)) return fail(`unknown event_type ${input.event_type}`);
  if (!nonEmptyString(input.actor_id)) return fail('actor_id is required');
  if (!nonEmptyString(input.submitted_by)) return fail('submitted_by is required');
  if (!nonEmptyString(input.idempotency_key)) return fail('idempotency_key is required');
  if (input.task_id !== null && input.task_id !== undefined && !nonEmptyString(input.task_id)) {
    return fail('task_id must be a string or null');
  }
  if (input.expected_task_version !== undefined && input.expected_task_version !== null &&
      (!Number.isInteger(input.expected_task_version) || input.expected_task_version < 0)) {
    return fail('expected_task_version must be a non-negative integer');
  }
  const payloadErr = validatePayload(input.event_type, input.payload);
  if (payloadErr) return fail(payloadErr);
  // Scope enforcement: each event type lives in exactly one scope.
  // task.created generates its task_id when absent; decision.changed,
  // handoff.posted and artifact.attached are dual-scope by design.
  const TASK_SCOPED = ['task.changed', 'message.posted', 'result.submitted', 'review.recorded'];
  if (TASK_SCOPED.includes(input.event_type) && !nonEmptyString(input.task_id)) {
    return fail(`${input.event_type} is task-scoped and requires task_id`);
  }
  if (input.event_type === 'agent.status_changed' && input.task_id != null) {
    return fail('agent.status_changed is workspace-scoped and requires task_id null');
  }
  // Status-transition legality is checked against the live projection at
  // append time (needs current status); payload shape is checked here.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rowToEvent(row) {
  return {
    event_id: row.event_id,
    task_id: row.task_id ?? null,
    seq: row.seq,
    event_type: row.event_type,
    actor_id: row.actor_id,
    submitted_by: row.submitted_by,
    created_at: row.created_at,
    caused_by_event_id: row.caused_by_event_id ?? null,
    idempotency_key: row.idempotency_key,
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload),
  };
}

function isConstraintViolation(err) {
  const msg = String(err && err.message || err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint|unique/i.test(msg);
}

function genTaskId() {
  return 'task_' + randomUUID().replace(/-/g, '');
}

function genDecisionId() {
  return 'dec_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function genArtifactId() {
  return 'art_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

// ---------------------------------------------------------------------------
// projections — pure functions of (event) -> SQL statements
// ---------------------------------------------------------------------------

function taskProjectionStmts(ev) {
  const t = ev.task_id;
  switch (ev.event_type) {
    case 'task.created': {
      const p = ev.payload;
      return [{
        sql: `INSERT INTO tasks (task_id, title, goal, priority, status, assignee, version,
                                 created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)`,
        params: [t, p.title, p.goal, p.priority || 'normal', ev.seq,
                 ev.actor_id, ev.created_at, ev.created_at],
      }];
    }
    case 'task.changed': {
      const p = ev.payload;
      // Claiming derives the status: assigning an owner to a pending task
      // moves it to claimed in the same write (009 compound decision —
      // derived, never a second event).
      if (p.field === 'assignee') {
        return [{
          sql: `UPDATE tasks SET assignee = ?,
                       status = CASE WHEN assignee IS NULL AND status = 'pending' AND ? IS NOT NULL
                                     THEN 'claimed' ELSE status END,
                       version = ?, updated_at = ? WHERE task_id = ?`,
          params: [p.to, p.to, ev.seq, ev.created_at, t],
        }];
      }
      const col = { status: 'status', priority: 'priority',
                    deadline: 'deadline', title: 'title' }[p.field];
      // `deadline` is stored on the tasks row; add the column lazily-safe via
      // COALESCE-free direct reference (column exists in schema v1).
      return [{
        sql: `UPDATE tasks SET ${col} = ?, version = ?, updated_at = ? WHERE task_id = ?`,
        params: [p.to, ev.seq, ev.created_at, t],
      }];
    }
    case 'result.submitted':
      return [{
        sql: `UPDATE tasks SET status = 'under-review', version = ?,
                     latest_result_event_id = ?, updated_at = ?
               WHERE task_id = ?`,
        params: [ev.seq, ev.event_id, ev.created_at, t],
      }];
    case 'review.recorded': {
      // The review decision drives the status machine directly (like
      // result.submitted -> under-review): accepted completes the task,
      // rework sends it back to in-progress. One command appends exactly
      // one event — the transition is derived, never a second write, so
      // recordReview is atomic by construction (009 compound decision).
      const next = ev.payload.outcome === 'accepted' ? 'completed' : 'in-progress';
      return [{
        sql: `UPDATE tasks SET status = ?, version = ?, latest_review_event_id = ?, updated_at = ?
               WHERE task_id = ?`,
        params: [next, ev.seq, ev.event_id, ev.created_at, t],
      }];
    }
    case 'message.posted': {
      const p = ev.payload;
      return [
        { sql: `INSERT INTO messages (event_id, task_id, seq, kind, body, reply_to, actor_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [ev.event_id, t, ev.seq, p.kind, p.body, p.reply_to ?? null, ev.actor_id, ev.created_at] },
        { sql: `UPDATE tasks SET version = ?, updated_at = ? WHERE task_id = ?`,
          params: [ev.seq, ev.created_at, t] },
      ];
    }
    case 'handoff.posted': {
      const p = ev.payload;
      return [
        { sql: `INSERT INTO handoffs (event_id, task_id, agent_id, goal, done, pending, key_context, refs, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [ev.event_id, t, p.agent_id || ev.actor_id, p.goal,
                   JSON.stringify(p.done || []), JSON.stringify(p.pending || []),
                   p.key_context ?? null, JSON.stringify(p.references || []),
                   p.reason ?? null, ev.created_at] },
        { sql: `UPDATE tasks SET version = ?, updated_at = ? WHERE task_id = ?`,
          params: [ev.seq, ev.created_at, t] },
      ];
    }
    case 'artifact.attached': {
      const p = ev.payload;
      return [
        { sql: `INSERT INTO artifact_refs (artifact_id, event_id, task_id, name, mime_type, uri, sha256, supersedes, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [p.artifact_id, ev.event_id, t, p.name,
                   p.mime_type ?? null, p.uri, p.sha256 ?? null, p.supersedes ?? null,
                   ev.actor_id, ev.created_at] },
        { sql: `UPDATE tasks SET version = ?, updated_at = ? WHERE task_id = ?`,
          params: [ev.seq, ev.created_at, t] },
      ];
    }
    default:
      return [];
  }
}

function applyProjection(ev) {
  const stmts = [];
  const t = ev.task_id;
  switch (ev.event_type) {
    case 'task.created':
    case 'task.changed':
    case 'message.posted':
    case 'handoff.posted':
    case 'artifact.attached':
      stmts.push(...taskProjectionStmts(ev));
      break;
    case 'result.submitted': {
      const p = ev.payload;
      stmts.push({
        sql: `INSERT INTO results (event_id, task_id, seq, summary, evidence, links, actor_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [ev.event_id, t, ev.seq, p.summary,
                 p.evidence ? JSON.stringify(p.evidence) : null,
                 p.links ? JSON.stringify(p.links) : null, ev.actor_id, ev.created_at],
      });
      stmts.push(...taskProjectionStmts(ev)); // status -> under-review, version bump
      break;
    }
    case 'review.recorded': {
      const p = ev.payload;
      stmts.push({
        sql: `INSERT INTO reviews (event_id, task_id, seq, outcome, notes, actor_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [ev.event_id, t, ev.seq, p.outcome, p.notes ?? null, ev.actor_id, ev.created_at],
      });
      stmts.push(...taskProjectionStmts(ev)); // version bump
      break;
    }
    case 'decision.changed': {
      const p = ev.payload;
      // p.decision_id is required by validation: projections are pure
      // functions of the event, so rebuilds reproduce identical state.
      const decisionId = p.decision_id;
      stmts.push({
        sql: `INSERT INTO decisions (decision_id, task_id, phase, question, options, resolution, version, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?)
              ON CONFLICT (decision_id) DO UPDATE SET
                phase = excluded.phase,
                question = COALESCE(excluded.question, decisions.question),
                options = COALESCE(excluded.options, decisions.options),
                resolution = COALESCE(excluded.resolution, decisions.resolution),
                version = decisions.version + 1,
                updated_at = excluded.updated_at`,
        params: [decisionId, t, p.phase, p.question ?? null,
                 p.options ? JSON.stringify(p.options) : null,
                 p.resolution ?? null, ev.created_at],
      });
      if (t) {
        stmts.push({
          sql: `UPDATE tasks SET version = ?, updated_at = ? WHERE task_id = ?`,
          params: [ev.seq, ev.created_at, t],
        });
      }
      break;
    }
    case 'agent.status_changed': {
      const p = ev.payload;
      const agentId = p.agent_id || ev.actor_id;
      stmts.push({
        sql: `INSERT INTO agents (agent_id, context_health, work_state, current_task_id, version, updated_at)
              VALUES (?, ?, ?, ?, 1, ?)
              ON CONFLICT (agent_id) DO UPDATE SET
                context_health = excluded.context_health,
                work_state = excluded.work_state,
                current_task_id = excluded.current_task_id,
                version = agents.version + 1,
                updated_at = excluded.updated_at`,
        params: [agentId, p.context_health, p.work_state, p.current_task_id ?? null, ev.created_at],
      });
      break;
    }
    default:
      throw new Error(`no projection for event_type ${ev.event_type}`);
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

// Retry budget for lost races. Sized for the expected team: even if every
// agent collides on the same scope at once, a bounded linear retry converges.
const MAX_APPEND_ATTEMPTS = 8;

// Current sequence position of a scope: tasks.version for a task scope,
// MAX(seq) over task-less events for the workspace scope. Every committed
// event in a scope advances exactly one of these, which is what lets the
// write-phase failure handler distinguish a genuine race (retry) from a
// projection conflict (surface the error).
async function readVersion(db, taskId) {
  if (taskId) {
    const t = await db.queryOne('SELECT version FROM tasks WHERE task_id = ?', [taskId]);
    return t ? t.version : 0;
  }
  const m = await db.queryOne('SELECT MAX(seq) AS m FROM events WHERE task_id IS NULL', []);
  return (m && m.m) || 0;
}

const TASK_FIELD_COLUMNS = { status: 'status', assignee: 'assignee', priority: 'priority',
                             deadline: 'deadline', title: 'title' };

// State-dependent validation: everything that needs the live projections.
// Runs AFTER the idempotency lookup, so a retry of a committed command is
// never re-validated against state that moved on.
async function validateAgainstState(db, input, taskId) {
  const t = input.event_type;
  const p = input.payload;

  let taskRow = null;
  if (taskId) {
    taskRow = await db.queryOne(
      'SELECT status, version, title, assignee, priority, deadline FROM tasks WHERE task_id = ?',
      [taskId]);
    if (!taskRow && t !== 'task.created') return fail(`task ${taskId} does not exist`);
  }

  if (t === 'task.changed') {
    if (p.field === 'status') {
      // The log must not record a false prior value: a supplied `from`
      // has to match the actual current status.
      if (p.from !== undefined && p.from !== taskRow.status) {
        return fail(`task.changed from mismatch: payload says ${JSON.stringify(p.from)}, actual status is ${taskRow.status}`);
      }
      const allowed = STATUS_TRANSITIONS[taskRow.status] || [];
      if (!allowed.includes(p.to)) {
        return { ok: false, code: 'VALIDATION_FAILED',
                 message: `illegal status transition ${taskRow.status} -> ${p.to}` };
      }
    } else {
      const col = TASK_FIELD_COLUMNS[p.field];
      const actual = taskRow[col] ?? null;
      const claimed = p.from ?? null;
      if (p.from !== undefined && claimed !== actual) {
        return fail(`task.changed from mismatch on ${p.field}: payload says ${JSON.stringify(claimed)}, actual is ${JSON.stringify(actual)}`);
      }
    }
  }

  // result.submitted drives the status machine directly (it is not a
  // task.changed), so it must respect the machine itself: results come
  // only from in-progress work, and completed stays terminal.
  if (t === 'result.submitted' && taskRow.status !== 'in-progress') {
    return fail(`result.submitted requires status in-progress, task is ${taskRow.status}`);
  }
  if (t === 'review.recorded' && taskRow.status !== 'under-review') {
    return fail(`review.recorded requires status under-review, task is ${taskRow.status}`);
  }
  return null;
}

/**
 * Append one event atomically (event row + projection updates in a single
 * batch). Returns:
 *   { ok:true, event }                       — appended
 *   { ok:true, event, replayed:true }         — idempotent retry, existing returned
 *   { ok:false, code:'VALIDATION_FAILED', message }
 *   { ok:false, code:'VERSION_CONFLICT', current_task_version }
 *   { ok:false, code:'PROJECTION_CONFLICT', message } — a projection
 *     constraint failed without any concurrent sequence advance (e.g.
 *     duplicate artifact_id); not a race, not retried blindly.
 *
 * Ordering guarantee: the idempotency lookup runs before ANY
 * state-dependent validation. A retry of an already-committed command
 * returns the original event even when re-validating it against current
 * state would fail (e.g. repeating a status change that already moved the
 * task). Only static input validation runs before the lookup. Within the
 * retry loop, state-dependent validation re-runs on every attempt against
 * that attempt's freshly-read state, so a retry after a lost race cannot
 * commit against assumptions a rival commit invalidated.
 */
export async function appendEvent(db, input, opts = {}) {
  const v = validateEvent(input);
  if (!v.ok) return v;

  const now = opts.now ?? Date.now();
  const taskId = input.task_id ?? (input.event_type === 'task.created' ? genTaskId() : null);
  const expected = input.expected_task_version ?? null;

  // Idempotency first: never re-validate a committed command against
  // state that has moved on since it was accepted.
  const preExisting = await db.queryOne(
    'SELECT * FROM events WHERE actor_id = ? AND idempotency_key = ?',
    [input.actor_id, input.idempotency_key]);
  if (preExisting) return { ok: true, event: rowToEvent(preExisting), replayed: true };

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    // ---- read phase (no locks held) ----
    const currentVersion = await readVersion(db, taskId);
    // Fast-path concurrency check: a stale expected version can never
    // succeed, so report it before validation. This keeps concurrent losers
    // deterministically on VERSION_CONFLICT instead of sometimes tripping
    // the from-match check after a rival commit.
    if (expected !== null && taskId && expected !== currentVersion) {
      return { ok: false, code: 'VERSION_CONFLICT', current_task_version: currentVersion };
    }
    // State-dependent validation runs on EVERY attempt, against this
    // attempt's state. After a lost race the world may have moved: a retry
    // must not commit against the assumptions of its original validation
    // (e.g. a result gate or a `from` value a rival commit invalidated).
    // Callers without expected_task_version are allowed, but each of their
    // retries is validated against the state it actually follows.
    const stateErr = await validateAgainstState(db, input, taskId);
    if (stateErr) {
      // A rival commit may have landed between this attempt's version read
      // and validation, making a merely-stale read look like an invalid
      // request (e.g. a from-mismatch). If the version moved, retry instead:
      // the next attempt's version check then reports VERSION_CONFLICT
      // deterministically for stale expected versions.
      if (taskId && await readVersion(db, taskId) !== currentVersion) continue;
      return stateErr;
    }

    const seq = currentVersion + 1;

    const event = {
      event_id: randomUUID(),
      task_id: taskId,
      seq,
      event_type: input.event_type,
      actor_id: input.actor_id,
      submitted_by: input.submitted_by,
      created_at: now,
      caused_by_event_id: input.caused_by_event_id ?? null,
      idempotency_key: input.idempotency_key,
      schema_version: SCHEMA_VERSION,
      payload: input.payload,
    };

    const stmts = [{
      sql: `INSERT INTO events (event_id, task_id, seq, event_type, actor_id, submitted_by,
                                created_at, caused_by_event_id, idempotency_key,
                                schema_version, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [event.event_id, event.task_id, event.seq, event.event_type,
               event.actor_id, event.submitted_by, event.created_at,
               event.caused_by_event_id, event.idempotency_key,
               event.schema_version, JSON.stringify(event.payload)],
    }, ...applyProjection(event)];

    // ---- write phase: single atomic batch (the linearization point) ----
    try {
      await db.batch(stmts);
      return { ok: true, event };
    } catch (err) {
      if (!isConstraintViolation(err)) throw err;
      // Lost a race (or hit a projection conflict). Re-check idempotency
      // first: a concurrent identical retry means we return the existing
      // event, not an error.
      const dup = await db.queryOne(
        'SELECT * FROM events WHERE actor_id = ? AND idempotency_key = ?',
        [input.actor_id, input.idempotency_key]);
      if (dup) return { ok: true, event: rowToEvent(dup), replayed: true };
      // Classify: did the relevant sequence advance since our read? Every
      // task-scoped event bumps tasks.version and every workspace event
      // bumps MAX(seq) over task-less events, so an advance means a genuine
      // concurrent commit (worth one retry); no advance means the batch
      // failed on a projection constraint, not a race.
      const cur = await readVersion(db, taskId);
      if (taskId && expected !== null && expected !== cur) {
        return { ok: false, code: 'VERSION_CONFLICT', current_task_version: cur };
      }
      if (cur === currentVersion) {
        return { ok: false, code: 'PROJECTION_CONFLICT',
                 message: String((err && err.message) || err) };
      }
      continue;
    }
  }
  return fail('append failed after retry');
}

/**
 * Rebuild all projections from the event stream. Events are untouched.
 * After: projections must equal the state produced by live appends.
 *
 * Limitation (documented, not a v1 blocker): the rebuild is destructive
 * and only chunk-atomic — projections are wiped first, then rebuilt in
 * chunks. If a chunk fails midway, projections are left partially rebuilt
 * and the operator must re-run. Do not expose this as a routine production
 * operation without shadow projections or another recovery strategy.
 */
export async function rebuildProjections(db, opts = {}) {
  const chunk = opts.chunkSize ?? 100;
  const drop = PROJECTION_TABLES.map((t) => ({ sql: `DELETE FROM ${t}`, params: [] }));
  await db.batch(drop);
  const events = await db.queryAll('SELECT * FROM events ORDER BY rowid', []);
  for (let i = 0; i < events.length; i += chunk) {
    const stmts = [];
    for (const row of events.slice(i, i + chunk)) {
      stmts.push(...applyProjection(rowToEvent(row)));
    }
    if (stmts.length) await db.batch(stmts);
  }
  return { rebuilt_events: events.length };
}

export { rowToEvent };
