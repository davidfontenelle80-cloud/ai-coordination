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

import { appendEvent } from './event-core.mjs';
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

function isOrdinaryAgent(principal) {
  return principal.kind === 'agent' && principal.role !== 'mateo';
}

async function getTaskRow(db, task_id) {
  if (!nonEmptyString(task_id)) throw cmdErr('VALIDATION_FAILED', 'task_id is required');
  const row = await db.queryOne(
    'SELECT task_id, status, assignee, version FROM tasks WHERE task_id = ?', [task_id]);
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

// ---------------------------------------------------------------------------
// Command -> event builders. Each returns a complete appendEvent() input.
// Throw cmdErr(VALIDATION_FAILED|FORBIDDEN|NOT_FOUND|TASK_ALREADY_CLAIMED).
// ---------------------------------------------------------------------------

async function buildCreateTask(db, input, ident) {
  if (!nonEmptyString(input.title)) throw cmdErr('VALIDATION_FAILED', 'createTask requires title');
  if (!nonEmptyString(input.goal)) throw cmdErr('VALIDATION_FAILED', 'createTask requires goal');
  return {
    event_type: 'task.created',
    task_id: nonEmptyString(input.task_id) ? input.task_id : `task_${uuid().slice(0, 8)}`,
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
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'assignee', from: null, to, reason: input.reason || 'claim' },
  };
}

async function buildStartTask(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  requireAssigned(principal, task, 'startTask');
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'status', from: task.status, to: 'in-progress', reason: input.reason || 'start' },
  };
}

async function buildBlockTask(db, input, ident, principal) {
  const task = await getTaskRow(db, input.task_id);
  requireAssigned(principal, task, 'blockTask');
  return {
    event_type: 'task.changed',
    task_id: task.task_id,
    payload: { field: 'status', from: task.status, to: 'blocked', reason: input.reason || 'blocked' },
  };
}

async function buildPostMessage(db, input) {
  const task = await getTaskRow(db, input.task_id);
  const kind = input.kind || 'message';
  if (!nonEmptyString(input.body)) throw cmdErr('VALIDATION_FAILED', 'postMessage requires body');
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
  return {
    event_type: 'review.recorded',
    task_id: task.task_id,
    ...(nonEmptyString(input.caused_by_event_id) ? { caused_by_event_id: input.caused_by_event_id } : {}),
    payload: {
      outcome: input.outcome,
      ...(input.notes !== undefined && input.notes !== null ? { notes: input.notes } : {}),
    },
  };
}

async function buildRequestDecision(db, input) {
  if (input.task_id) await getTaskRow(db, input.task_id);
  if (!nonEmptyString(input.question)) throw cmdErr('VALIDATION_FAILED', 'requestDecision requires question');
  return {
    event_type: 'decision.changed',
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      decision_id: `dec_${uuid().slice(0, 8)}`,
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
    throw cmdErr('VALIDATION_FAILED', `decision ${input.decision_id} is already ${row.phase}`);
  }
  return {
    event_type: 'decision.changed',
    ...(row.task_id ? { task_id: row.task_id } : {}),
    payload: { decision_id: row.decision_id, phase: 'resolved', resolution: input.resolution },
  };
}

async function buildPostHandoff(db, input, ident, principal) {
  if (input.task_id) await getTaskRow(db, input.task_id);
  if (!nonEmptyString(input.goal)) throw cmdErr('VALIDATION_FAILED', 'postHandoff requires goal');
  // A handoff describes the poster's own state: ordinary agents cannot file
  // one as somebody else.
  const agent_id = isOrdinaryAgent(principal) ? ident.actor_id : (input.agent_id || ident.actor_id);
  return {
    event_type: 'handoff.posted',
    ...(input.task_id ? { task_id: input.task_id } : {}),
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

async function buildAttachArtifact(db, input) {
  if (input.task_id) await getTaskRow(db, input.task_id);
  if (!nonEmptyString(input.name)) throw cmdErr('VALIDATION_FAILED', 'attachArtifact requires name');
  if (!nonEmptyString(input.uri)) throw cmdErr('VALIDATION_FAILED', 'attachArtifact requires uri');
  return {
    event_type: 'artifact.attached',
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      artifact_id: `art_${uuid().slice(0, 8)}`,
      name: input.name,
      uri: input.uri,
      ...(input.mime_type ? { mime_type: input.mime_type } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    },
  };
}

async function buildSetAgentStatus(db, input, ident, principal) {
  // Ordinary agents can only report their own status.
  const agent_id = isOrdinaryAgent(principal) ? ident.actor_id : (input.agent_id || ident.actor_id);
  if (!nonEmptyString(input.context_health)) throw cmdErr('VALIDATION_FAILED', 'setAgentStatus requires context_health');
  if (!nonEmptyString(input.work_state)) throw cmdErr('VALIDATION_FAILED', 'setAgentStatus requires work_state');
  if (!('current_task_id' in input)) {
    throw cmdErr('VALIDATION_FAILED', 'setAgentStatus requires current_task_id (string or null)');
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
    return { ok: false, code: 'PROJECTION_CONFLICT', message: res.message, retryable: false, ...extra };
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
    if (/illegal status transition|from mismatch/i.test(res.message)) {
      return { ok: false, code: 'INVALID_TRANSITION', message: res.message, retryable: true, ...extra };
    }
    return { ok: false, code: 'VALIDATION_FAILED', message: res.message, retryable: false, ...extra };
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
  eventInput.idempotency_key = nonEmptyString(input.idempotency_key) ? input.idempotency_key : `cmd_${uuid()}`;
  if (input.expected_task_version !== undefined) {
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
