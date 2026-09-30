/**
 * commands.mjs — task 009 domain command layer.
 *
 * One command appends exactly one domain event through the hardened
 * appendEvent() path. Compound domain actions (accepted review completing a
 * task, result submission moving a task to under-review) are derived by the
 * projections, never by writing two events — atomic by construction.
 *
 * Every inbound command runs applyPrincipalIdentity() first: actor_id and
 * submitted_by come from the authenticated principal, never the request
 * body (ChatGPT's 008 boundary).
 */

import { appendEvent, MESSAGE_KINDS, CONTEXT_HEALTHS, WORK_STATES } from './event-core.mjs';
import { authorize, principalIdentity } from './auth.mjs';

// ---------------------------------------------------------------------------
// 009 command surface.
// ---------------------------------------------------------------------------

export const COMMANDS = [
  'createTask',
  'claimTask',
  'startTask',
  'blockTask',
  'postMessage',
  'submitResult',
  'recordReview',
  'requestDecision',
  'resolveDecision',
  'postHandoff',
  'attachArtifact',
  'setAgentStatus',
];

function cmdErr(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The command layer is the public API contract: builders fully validate
// payload shape here, before constructing an event. That makes the
// appendEvent invariant true — VALIDATION_FAILED from the core is a
// state-dependent rejection (state machine, rival claim, missing row),
// never malformed input — so mapping it to INVALID_TRANSITION is
// defensible. (ChatGPT 009 re-review blocker.)
function requireAgentId(value, command) {
  if (value !== undefined && value !== null && !nonEmptyString(value)) {
    throw cmdErr('VALIDATION_FAILED', `${command} agent_id must be a non-empty string`);
  }
}

function requireReasonString(input, command) {
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    throw cmdErr('VALIDATION_FAILED', `${command} reason must be a string`);
  }
}

// Optional task scoping uses explicit presence semantics: undefined/null
// means workspace scope, a non-empty string means task scope, and anything
// else (including "" or 0) is malformed input — truthiness must not
// silently convert a task-scoped command into a workspace one.
// (ChatGPT 009 final re-review.)
function optionalTaskId(value, command) {
  if (value === undefined || value === null) return null;
  if (!nonEmptyString(value)) {
    throw cmdErr('VALIDATION_FAILED', `${command} task_id must be a non-empty string or null`);
  }
  return value;
}

function isOrdinaryAgent(principal) {
  return principal.kind === 'agent' && principal.role !== 'mateo';
}

async function getTaskRow(db, task_id) {
  if (!nonEmptyString(task_id)) throw cmdErr('VALIDATION_FAILED', 'task_id is required');
  const row = await db.queryOne(
    'SELECT task_id, status, assignee, version, latest_result_event_id FROM tasks WHERE task_id = ?', [task_id]);
  if (!row) throw cmdErr('NOT_FOUND', `task ${task_id} does not exist`);
  return row;
}

// Ordinary agents may only act on tasks assigned to them. Mateo and David
// are unrestricted.
function requireAssigned(principal, taskRow, command) {
  if (isOrdinaryAgent(principal) && taskRow.assignee !== principal.agent_id) {
    throw cmdErr('FORBIDDEN',
      `${command} is limited to the assigned agent (task is assigned to ${taskRow.assignee ?? 'nobody'})`);
  }
}

function uuid() {
  return crypto.randomUUID();
}

// Full-entropy server IDs: never truncate UUIDs. These become durable
// references (ChatGPT 009 review), so 32-bit prefixes are not acceptable.
function genId(prefix) {
  return `${prefix}_${uuid().replace(/-/g, '')}`;
}

// v1 link policy: https: only. Anything else is rejected at the command
// boundary (submitResult links, artifact URIs).
function httpsUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command -> event builders. Each returns a complete appendEvent() input.
// Throw cmdErr(VALIDATION_FAILED|FORBIDDEN|NOT_FOUND|TASK_ALREADY_CLAIMED).
// ---------------------------------------------------------------------------

async function buildCreateTask(db, input, ident) {
  if (!nonEmptyString(input.title)) throw cmdErr('VALIDATION_FAILED', 'createTask requires title');
  if (!nonEmptyString(input.goal)) throw cmdErr('VALIDATION_FAILED', 'createTask requires goal');
  // A caller-supplied task_id or priority that is malformed is rejected,
  // not silently replaced: bad input must not quietly change meaning.
  // (ChatGPT 009 re-review.)
  if (input.task_id !== undefined && input.task_id !== null && !nonEmptyString(input.task_id)) {
    throw cmdErr('VALIDATION_FAILED', 'createTask task_id must be a non-empty string');
  }
  if (input.priority !== undefined && input.priority !== null && !nonEmptyString(input.priority)) {
    throw cmdErr('VALIDATION_FAILED', 'createTask priority must be a non-empty string');
  }
  return {
    event_type: 'task.created',
    task_id: nonEmptyString(input.task_id) ? input.task_id : genId('task'),
    payload: {
      title: input.title,
      goal: input.goal,
      ...(nonEmptyString(input.priority) ? { priority: input.priority } : {}),
    },
  };
}

async function buildClaimTask(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  // Mateo/David may claim on behalf of another agent; ordinary agents
  // always claim for themselves.
  let to = ident.actor_id;
  if (input.assignee !== undefined && input.assignee !== null) {
    if (isOrdinaryAgent(principal) && input.assignee !== ident.actor_id) {
      throw cmdErr('FORBIDDEN', 'agents may only claim tasks for themselves');
    }
    if (!nonEmptyString(input.assignee)) throw cmdErr('VALIDATION_FAILED', 'assignee must be a non-empty string');
    to = input.assignee;
  }
  if (task.assignee !== null && task.assignee !== undefined) {
    throw cmdErr('TASK_ALREADY_CLAIMED', `task ${task.task_id} is already claimed by ${task.assignee}`,
      { current_task_version: task.version });
  }
  // Ordinary agents may only claim genuinely claimable work: a pending,
  // unassigned task. Claiming completed/under-review/blocked work is a
  // coordinator (Mateo/David) action, not self-claim. (ChatGPT 009 review.)
  if (isOrdinaryAgent(principal) && task.status !== 'pending') {
    throw cmdErr('FORBIDDEN', `claimTask is only available on pending tasks; task ${task.task_id} is ${task.status}`);
  }
  requireReasonString(input, 'claimTask');
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'assignee', from: null, to, reason: input.reason || 'claim' },
  };
}

async function buildStartTask(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  requireAssigned(principal, task, 'startTask');
  requireReasonString(input, 'startTask');
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'status', from: task.status, to: 'in-progress', reason: input.reason || 'start' },
  };
}

async function buildBlockTask(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  requireAssigned(principal, task, 'blockTask');
  requireReasonString(input, 'blockTask');
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'status', from: task.status, to: 'blocked', reason: input.reason || 'blocked' },
  };
}

async function buildPostMessage(db, input) {
  const task = await getTaskRow(db, input.task_id);
  // kind is an enum, not free text: validate it at the boundary so the
  // core never sees a malformed kind. (ChatGPT 009 re-review blocker.)
  const kind = input.kind === undefined || input.kind === null ? 'message' : input.kind;
  if (!MESSAGE_KINDS.includes(kind)) {
    throw cmdErr('VALIDATION_FAILED', `postMessage kind must be one of ${MESSAGE_KINDS.join(', ')}`);
  }
  if (!nonEmptyString(input.body)) throw cmdErr('VALIDATION_FAILED', 'postMessage requires body');
  if (input.reply_to !== undefined && input.reply_to !== null && !nonEmptyString(input.reply_to)) {
    throw cmdErr('VALIDATION_FAILED', 'postMessage reply_to must be a non-empty string');
  }
  return {
    event_type: 'message.posted',
    task_id: task.task_id,
    payload: {
      kind,
      body: input.body,
      ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    },
  };
}

async function buildSubmitResult(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  requireAssigned(principal, task, 'submitResult');
  if (!nonEmptyString(input.summary)) throw cmdErr('VALIDATION_FAILED', 'submitResult requires summary');
  if (input.links !== undefined) {
    if (!Array.isArray(input.links)) throw cmdErr('VALIDATION_FAILED', 'submitResult links must be an array');
    // Promised link validation: every entry must be an https: URL.
    // (ChatGPT 009 review.)
    for (const link of input.links) {
      if (!httpsUrl(link)) {
        throw cmdErr('VALIDATION_FAILED', 'submitResult links must all be https: URLs');
      }
    }
  }
  // evidence must be an object (or null): validate here, not in the core.
  // (ChatGPT 009 re-review blocker.)
  if (input.evidence !== undefined && input.evidence !== null && !isPlainObject(input.evidence)) {
    throw cmdErr('VALIDATION_FAILED', 'submitResult evidence must be an object');
  }
  return {
    event_type: 'result.submitted',
    task_id: task.task_id,
    payload: {
      summary: input.summary,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.links !== undefined ? { links: input.links } : {}),
    },
  };
}

async function buildRecordReview(db, input) {
  const task = await getTaskRow(db, input.task_id);
  if (input.outcome !== 'accepted' && input.outcome !== 'rework') {
    throw cmdErr('VALIDATION_FAILED', 'recordReview outcome must be accepted or rework');
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    throw cmdErr('VALIDATION_FAILED', 'recordReview notes must be a string');
  }
  // Review linkage is server-derived from the task's current result, never
  // caller-supplied: the server knows which result is under review, so an
  // accidental stale event id cannot corrupt the audit trail.
  // (ChatGPT 009 review.)
  return {
    event_type: 'review.recorded',
    task_id: task.task_id,
    ...(task.latest_result_event_id ? { caused_by_event_id: task.latest_result_event_id } : {}),
    payload: {
      outcome: input.outcome,
      ...(input.notes !== undefined && input.notes !== null ? { notes: input.notes } : {}),
    },
  };
}

async function buildRequestDecision(db, input, ident, principal) {
  const taskId = optionalTaskId(input.task_id, 'requestDecision');
  if (taskId) {
    const task = await getTaskRow(db, taskId);
    // An ordinary agent requests David decisions from a task it owns —
    // it must not inject decisions into somebody else's task.
    requireAssigned(principal, task, 'requestDecision');
  }
  if (!nonEmptyString(input.question)) throw cmdErr('VALIDATION_FAILED', 'requestDecision requires question');
  // options must be an array when present: validate at the boundary.
  // (ChatGPT 009 re-review blocker.)
  if (input.options !== undefined && !Array.isArray(input.options)) {
    throw cmdErr('VALIDATION_FAILED', 'requestDecision options must be an array');
  }
  return {
    event_type: 'decision.changed',
    ...(taskId ? { task_id: taskId } : {}),
    payload: {
      decision_id: genId('dec'),
      phase: 'requested',
      question: input.question,
      ...(input.options !== undefined ? { options: input.options } : {}),
    },
  };
}

async function buildResolveDecision(db, input) {
  if (!nonEmptyString(input.decision_id)) throw cmdErr('VALIDATION_FAILED', 'resolveDecision requires decision_id');
  if (!nonEmptyString(input.resolution)) throw cmdErr('VALIDATION_FAILED', 'resolveDecision requires resolution');
  const row = await db.queryOne(
    'SELECT decision_id, task_id, phase FROM decisions WHERE decision_id = ?', [input.decision_id]);
  if (!row) throw cmdErr('NOT_FOUND', `decision ${input.decision_id} does not exist`);
  if (row.phase !== 'requested') {
    throw cmdErr('INVALID_TRANSITION', `decision ${input.decision_id} is already ${row.phase}`);
  }
  return {
    event_type: 'decision.changed',
    ...(row.task_id ? { task_id: row.task_id } : {}),
    payload: { decision_id: row.decision_id, phase: 'resolved', resolution: input.resolution },
  };
}

async function buildPostHandoff(db, input, ident, principal) {
  const taskId = optionalTaskId(input.task_id, 'postHandoff');
  if (taskId) {
    const task = await getTaskRow(db, taskId);
    // A handoff is operational state, not discussion: ordinary agents may
    // only file one on a task they own. Cross-task chatter belongs in
    // postMessage. (ChatGPT 009 review.)
    requireAssigned(principal, task, 'postHandoff');
  }
  if (!nonEmptyString(input.goal)) throw cmdErr('VALIDATION_FAILED', 'postHandoff requires goal');
  // Handoff payload shape is validated at the boundary: done/pending/
  // references are arrays, key_context/reason are strings.
  // (ChatGPT 009 re-review blocker.)
  for (const f of ['done', 'pending', 'references']) {
    if (input[f] !== undefined && !Array.isArray(input[f])) {
      throw cmdErr('VALIDATION_FAILED', `postHandoff ${f} must be an array`);
    }
  }
  for (const f of ['key_context', 'reason']) {
    if (input[f] !== undefined && input[f] !== null && typeof input[f] !== 'string') {
      throw cmdErr('VALIDATION_FAILED', `postHandoff ${f} must be a string`);
    }
  }
  // A handoff describes the poster's own state: ordinary agents cannot file
  // one as somebody else.
  requireAgentId(input.agent_id, 'postHandoff');
  const agent_id = isOrdinaryAgent(principal) ? ident.actor_id : (input.agent_id || ident.actor_id);
  return {
    event_type: 'handoff.posted',
    ...(taskId ? { task_id: taskId } : {}),
    payload: {
      agent_id,
      goal: input.goal,
      ...(input.done !== undefined ? { done: input.done } : {}),
      ...(input.pending !== undefined ? { pending: input.pending } : {}),
      ...(input.key_context ? { key_context: input.key_context } : {}),
      ...(input.references !== undefined ? { references: input.references } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

async function buildAttachArtifact(db, input, ident, principal) {
  const taskId = optionalTaskId(input.task_id, 'attachArtifact');
  if (taskId) {
    const task = await getTaskRow(db, taskId);
    // Artifacts join the durable task record / resume packet: ordinary
    // agents may only attach to a task they own. (ChatGPT 009 review.)
    requireAssigned(principal, task, 'attachArtifact');
  }
  if (!nonEmptyString(input.name)) throw cmdErr('VALIDATION_FAILED', 'attachArtifact requires name');
  if (!nonEmptyString(input.uri)) throw cmdErr('VALIDATION_FAILED', 'attachArtifact requires uri');
  if (!httpsUrl(input.uri)) {
    throw cmdErr('VALIDATION_FAILED', 'attachArtifact requires an https: uri');
  }
  // mime_type/sha256 are non-empty strings when present — truthiness is
  // not validation. (ChatGPT 009 re-review blocker.)
  for (const f of ['mime_type', 'sha256']) {
    if (input[f] !== undefined && input[f] !== null && !nonEmptyString(input[f])) {
      throw cmdErr('VALIDATION_FAILED', `attachArtifact ${f} must be a non-empty string`);
    }
  }
  return {
    event_type: 'artifact.attached',
    ...(taskId ? { task_id: taskId } : {}),
    payload: {
      artifact_id: genId('art'),
      name: input.name,
      uri: input.uri,
      ...(input.mime_type ? { mime_type: input.mime_type } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    },
  };
}

async function buildSetAgentStatus(db, input, ident, principal) {
  // Ordinary agents can only report their own status.
  requireAgentId(input.agent_id, 'setAgentStatus');
  const agent_id = isOrdinaryAgent(principal) ? ident.actor_id : (input.agent_id || ident.actor_id);
  // context_health and work_state are enums, not free text: an unknown
  // value is malformed input, not a state transition.
  // (ChatGPT 009 re-review blocker.)
  if (!CONTEXT_HEALTHS.includes(input.context_health)) {
    throw cmdErr('VALIDATION_FAILED', `setAgentStatus context_health must be one of ${CONTEXT_HEALTHS.join(', ')}`);
  }
  if (!WORK_STATES.includes(input.work_state)) {
    throw cmdErr('VALIDATION_FAILED', `setAgentStatus work_state must be one of ${WORK_STATES.join(', ')}`);
  }
  if (!('current_task_id' in input)) {
    throw cmdErr('VALIDATION_FAILED', 'setAgentStatus requires current_task_id (string or null)');
  }
  if (input.current_task_id !== null && !nonEmptyString(input.current_task_id)) {
    throw cmdErr('VALIDATION_FAILED', 'setAgentStatus current_task_id must be a string or null');
  }
  return {
    event_type: 'agent.status_changed',
    payload: {
      agent_id,
      context_health: input.context_health,
      work_state: input.work_state,
      current_task_id: input.current_task_id,
    },
  };
}

const BUILDERS = {
  createTask: buildCreateTask,
  claimTask: buildClaimTask,
  startTask: buildStartTask,
  blockTask: buildBlockTask,
  postMessage: buildPostMessage,
  submitResult: buildSubmitResult,
  recordReview: buildRecordReview,
  requestDecision: buildRequestDecision,
  resolveDecision: buildResolveDecision,
  postHandoff: buildPostHandoff,
  attachArtifact: buildAttachArtifact,
  setAgentStatus: buildSetAgentStatus,
};

// ---------------------------------------------------------------------------
// Failure mapping: core codes -> 009 HTTP error contract.
// ---------------------------------------------------------------------------

function mapAppendFailure(res, command, task_id) {
  const extra = { ...(res.current_task_version !== undefined ? { current_task_version: res.current_task_version } : {}) };
  if (res.code === 'VERSION_CONFLICT') {
    return { ok: false, code: 'VERSION_CONFLICT', message: res.message, retryable: true, ...extra };
  }
  if (res.code === 'PROJECTION_CONFLICT') {
    // Never expose raw SQLite/D1 constraint text to API clients: the
    // underlying message is logged server-side for operators instead.
    // (ChatGPT 009 review.)
    console.error(`PROJECTION_CONFLICT on ${command}:`, res.message);
    return { ok: false, code: 'PROJECTION_CONFLICT',
      message: 'the command conflicted with existing projected state',
      retryable: false, ...extra };
  }
  if (res.code === 'VALIDATION_FAILED') {
    if (command === 'claimTask' && /from mismatch/i.test(res.message)) {
      // A rival claimed between our check and our append. Fail closed with
      // the same code and retryable flag as the pre-check path; surface who
      // won so the caller can decide what to do next.
      const m = /actual is ("[^"]*")/.exec(res.message || '');
      return { ok: false, code: 'TASK_ALREADY_CLAIMED',
        message: 'task was claimed by a rival between check and append',
        retryable: false,
        ...(m ? { conflicting_assignee: JSON.parse(m[1]) } : {}), ...extra };
    }
    // Builders fully validate payload shape at the command boundary, so a
    // core VALIDATION_FAILED at append time is a state-machine violation,
    // not bad input: the JSON was fine and the task/decision's current
    // state forbids the operation. Blindly retrying the identical request
    // can never succeed — retryable:false — while a stale client view
    // surfaces separately as VERSION_CONFLICT (retryable after refresh).
    // (ChatGPT 009 review #5; re-review blocker resolved by completing
    // builder validation.)
    return { ok: false, code: 'INVALID_TRANSITION', message: res.message, retryable: false, ...extra };
  }
  return { ok: false, code: res.code || 'COMMAND_FAILED', message: res.message || 'command failed', retryable: false, ...extra };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Execute one domain command as `principal`.
 * Returns { ok:true, command, event_id, seq, event_type, task_id, version,
 *           idempotency_key } or { ok:false, code, message, retryable?, ... }.
 * Throws only on unexpected internal errors.
 */
export async function executeCommand(db, principal, rawInput, { now = Date.now() } = {}) {
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};

  const command = input.command;
  if (!nonEmptyString(command)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'command is required', retryable: false };
  }
  if (!COMMANDS.includes(command)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: `unknown command ${command}`, retryable: false };
  }

  // Auth before anything else.
  if (!principal) {
    return { ok: false, code: 'AUTH_REQUIRED', message: 'authentication required', retryable: false };
  }
  if (!authorize(principal, command)) {
    return { ok: false, code: 'FORBIDDEN', message: `${command} is not permitted for this principal`, retryable: false };
  }

  // Server-derived identity: caller-supplied actor_id/submitted_by are
  // discarded (ChatGPT's 008 boundary).
  const ident = principalIdentity(principal);
  const trusted = { ...input, actor_id: ident.actor_id, submitted_by: ident.submitted_by };

  // Idempotency keys are REQUIRED on every mutating command. A server-
  // generated replacement would defeat the entire purpose: the client never
  // received the first key, so it cannot replay it after a lost response.
  // (ChatGPT 009 review, problem A.)
  if (!nonEmptyString(input.idempotency_key)) {
    return {
      ok: false, code: 'VALIDATION_FAILED',
      message: 'idempotency_key is required on every mutating command; generate a UUID client-side and reuse it on retry',
      retryable: false,
    };
  }

  // Command-level idempotency preflight: some builders reject retries on
  // live-state validation (e.g. claimTask sees the task already assigned and
  // returns TASK_ALREADY_CLAIMED) before the core's idempotency lookup ever
  // runs. Replay the original committed result first, before any builder.
  // (ChatGPT 009 review, problem B — blocker.)
  const prior = await db.queryOne(
    'SELECT event_id, seq, event_type, task_id FROM events WHERE actor_id = ? AND idempotency_key = ?',
    [ident.actor_id, input.idempotency_key]);
  if (prior) {
    return {
      ok: true,
      command,
      event_id: prior.event_id,
      seq: prior.seq,
      event_type: prior.event_type,
      task_id: prior.task_id,
      version: prior.task_id ? prior.seq : undefined,
      idempotency_key: input.idempotency_key,
      replayed: true,
    };
  }

  let eventInput;
  try {
    eventInput = await BUILDERS[command](db, trusted, ident, principal);
  } catch (e) {
    if (e.code) {
      return { ok: false, code: e.code, message: e.message, retryable: false, ...(e.extra || {}) };
    }
    throw e;
  }

  eventInput.actor_id = ident.actor_id;
  eventInput.submitted_by = ident.submitted_by;
  eventInput.idempotency_key = input.idempotency_key;
  if (input.expected_task_version !== undefined) {
    // Optimistic-concurrency guard is validated at the boundary too: a
    // malformed version is bad input, not a state transition.
    if (!Number.isInteger(input.expected_task_version) || input.expected_task_version < 0) {
      return { ok: false, code: 'VALIDATION_FAILED',
        message: 'expected_task_version must be a non-negative integer', retryable: false };
    }
    eventInput.expected_task_version = input.expected_task_version;
  }

  const res = await appendEvent(db, eventInput, { now });
  if (!res.ok) return mapAppendFailure(res, command, eventInput.task_id || null);

  return {
    ok: true,
    command,
    event_id: res.event.event_id,
    seq: res.event.seq,
    event_type: res.event.event_type,
    task_id: res.event.task_id,
    version: res.event.task_id ? res.event.seq : undefined,
    idempotency_key: eventInput.idempotency_key,
    replayed: !!res.replayed,
  };
}
