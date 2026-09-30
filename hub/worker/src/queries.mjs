/**
 * queries.mjs — task 009 read models.
 *
 * All reads are served from the D1 projections (no event replay on read).
 * Every function is pure async over the db adapter; HTTP mapping lives in
 * index.mjs.
 */

function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function parsePayload(row) {
  if (row && typeof row.payload === 'string') row.payload = parseJson(row.payload, {});
  return row;
}

const TASK_COLUMNS = `task_id, title, goal, status, assignee, priority, deadline,
  version, created_by, latest_result_event_id, latest_review_event_id,
  created_at, updated_at`;

/** GET /tasks — filterable list. */
export async function listTasks(db, { status, assignee, limit } = {}) {
  const conds = [];
  const params = [];
  if (status) { conds.push('status = ?'); params.push(status); }
  if (assignee) { conds.push('assignee = ?'); params.push(assignee); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = limit == null ? 100 : Math.min(Math.max(limit | 0, 1), 200);
  const rows = await db.queryAll(
    `SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`,
    [...params, lim]);
  return { tasks: rows };
}

/** GET /tasks/{id} */
export async function getTask(db, task_id) {
  const task = await db.queryOne(`SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id = ?`, [task_id]);
  return task || null;
}

/** GET /tasks/{id}/events?after_seq= */
export async function getTaskEvents(db, task_id, { after_seq, limit } = {}) {
  const task = await db.queryOne('SELECT task_id FROM tasks WHERE task_id = ?', [task_id]);
  if (!task) return null;
  const after = after_seq == null ? 0 : (after_seq | 0);
  const lim = limit == null ? 200 : Math.min(Math.max(limit | 0, 1), 500);
  const rows = await db.queryAll(
    `SELECT event_id, seq, event_type, actor_id, submitted_by, caused_by_event_id, created_at, payload
     FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    [task_id, after, lim]);
  return { task_id, events: rows.map(parsePayload) };
}

/**
 * GET /tasks/{id}/resume — the handoff packet: everything an agent needs to
 * pick up a task without replaying the log.
 */
export async function getResume(db, task_id) {
  const task = await getTask(db, task_id);
  if (!task) return null;

  const latestResult = await db.queryOne(
    `SELECT summary, evidence, links, actor_id, created_at FROM results
     WHERE task_id = ? ORDER BY seq DESC LIMIT 1`, [task_id]);
  const latestReview = await db.queryOne(
    `SELECT outcome, notes, actor_id, created_at FROM reviews
     WHERE task_id = ? ORDER BY seq DESC LIMIT 1`, [task_id]);
  const messages = await db.queryAll(
    `SELECT kind, body, actor_id, created_at FROM messages
     WHERE task_id = ? ORDER BY seq DESC LIMIT 10`, [task_id]);
  const artifacts = await db.queryAll(
    `SELECT artifact_id, name, uri, mime_type FROM artifact_refs
     WHERE task_id = ? ORDER BY created_at ASC`, [task_id]);
  const openDecisions = await db.queryAll(
    `SELECT decision_id, question, options FROM decisions
     WHERE task_id = ? AND phase = 'requested' ORDER BY updated_at ASC`, [task_id]);
  // Resume contract also needs the durable context a replacement agent
  // needs after a context reset: what David already decided, and the
  // latest handoff packet. (ChatGPT 009 review.)
  const resolvedDecisions = await db.queryAll(
    `SELECT decision_id, question, resolution, updated_at FROM decisions
     WHERE task_id = ? AND phase = 'resolved' ORDER BY updated_at DESC LIMIT 10`, [task_id]);
  const latestHandoff = await db.queryOne(
    `SELECT agent_id, goal, done, pending, key_context, refs, reason, created_at FROM handoffs
     WHERE task_id = ? ORDER BY handoff_id DESC LIMIT 1`, [task_id]);

  let blockedReason = null;
  if (task.status === 'blocked') {
    // The LATEST status change, not the latest task.changed of any kind: a
    // later priority/assignee change must not erase the block reason. Query
    // specifically for status-change payloads via JSON extraction, so the
    // answer is exact no matter how many later non-status events exist —
    // no arbitrary scan limit. (ChatGPT 009 review + re-review.)
    const row = await db.queryOne(
      `SELECT payload FROM events
       WHERE task_id = ? AND event_type = 'task.changed'
         AND json_extract(payload, '$.field') = 'status'
       ORDER BY seq DESC LIMIT 1`, [task_id]);
    if (row) blockedReason = parseJson(row.payload, {}).reason || null;
  }

  return {
    task,
    version: task.version,
    status: task.status,
    assignee: task.assignee,
    latest_result: latestResult
      ? { ...latestResult, evidence: parseJson(latestResult.evidence), links: parseJson(latestResult.links, []) }
      : null,
    latest_review: latestReview,
    recent_messages: messages.reverse(),
    artifact_refs: artifacts,
    open_decisions: openDecisions.map((d) => ({ ...d, options: parseJson(d.options, []) })),
    resolved_decisions: resolvedDecisions,
    latest_handoff: latestHandoff
      ? { ...latestHandoff, done: parseJson(latestHandoff.done, []), pending: parseJson(latestHandoff.pending, []),
          refs: parseJson(latestHandoff.refs, []) }
      : null,
    blocked_reason: blockedReason,
  };
}

/** GET /activity — recent events across all scopes. */
export async function getActivity(db, { limit } = {}) {
  const lim = limit == null ? 50 : Math.min(Math.max(limit | 0, 1), 200);
  const rows = await db.queryAll(
    `SELECT event_id, seq, task_id, event_type, actor_id, submitted_by, created_at, payload
     FROM events ORDER BY rowid DESC LIMIT ?`,
    [lim]);
  // Task 015: the dashboard chat thread renders message.posted bodies from
  // this feed, so the payload rides along (additive field; no consumer is
  // required to read it).
  return { events: rows.map(parsePayload) };
}

/** GET /decisions?state= */
export async function listDecisions(db, { state } = {}) {
  const where = state ? 'WHERE phase = ?' : '';
  const params = state ? [state] : [];
  const rows = await db.queryAll(
    `SELECT decision_id, task_id, phase, question, options, resolution, version, updated_at
     FROM decisions ${where} ORDER BY updated_at DESC`, params);
  return { decisions: rows.map((d) => ({ ...d, options: parseJson(d.options, []) })) };
}

/** GET /agents — live agent status projection. */
export async function listAgents(db) {
  const rows = await db.queryAll(
    `SELECT agent_id, context_health, work_state, current_task_id, updated_at
     FROM agents ORDER BY agent_id ASC`, []);
  return { agents: rows };
}

/**
 * GET /api/stats — task 010 quota-safety indicators.
 *
 * Deliberately limited to what we control (our own rows), not precise
 * Cloudflare account telemetry: event counts, today's event/command
 * volume, task/decisions/agent tallies. Each command appends exactly one
 * event, so events_today is the command-volume proxy.
 */
export async function getStats(db) {
  const startOfDayUtc = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const events_total = (await db.queryOne('SELECT COUNT(*) c FROM events')).c;
  const events_today = (await db.queryOne(
    'SELECT COUNT(*) c FROM events WHERE created_at >= ?', [startOfDayUtc])).c;
  const statusRows = await db.queryAll(
    'SELECT status, COUNT(*) c FROM tasks GROUP BY status', []);
  const tasks_by_status = {};
  let tasks_total = 0;
  for (const r of statusRows) {
    tasks_by_status[r.status] = r.c;
    tasks_total += r.c;
  }
  const decisions_open = (await db.queryOne(
    "SELECT COUNT(*) c FROM decisions WHERE phase = 'requested'")).c;
  const agents_count = (await db.queryOne('SELECT COUNT(*) c FROM agents')).c;
  return {
    events_total, events_today,
    tasks_total, tasks_by_status,
    decisions_open, agents_count,
  };
}

// ---------------------------------------------------------------------------
// Task 019: the read surface as one table.
//
// The REST router (index.mjs, GET /api/*) and the MCP tool catalog
// (mcp.mjs) both dispatch through QUERIES, so a query's behavior, its
// not-found contract, and its advertised input schema cannot drift apart.
// Each run() returns the hub response envelope: { ok:true, ... } or
// { ok:false, code, message }.
// ---------------------------------------------------------------------------

const taskNotFound = (task_id) => ({ ok: false, code: 'NOT_FOUND', message: `task ${task_id} not found` });

const TASK_ID_PROP = { type: 'string', minLength: 1, description: 'Task id, e.g. "task_…".' };

export const QUERIES = {
  list_tasks: {
    rest: 'GET /api/tasks',
    description: 'List tasks, most recently updated first. Optional filters: status, assignee (agent_id).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending | claimed | in-progress | under-review | completed | blocked' },
        assignee: { type: 'string', description: 'agent_id of the assignee' },
        limit: { type: 'integer', description: 'Max rows (default 100, clamped to 1..200).' },
      },
    },
    run: async (db, a) =>
      ({ ok: true, ...(await listTasks(db, { status: a.status, assignee: a.assignee, limit: a.limit })) }),
  },
  get_task: {
    rest: 'GET /api/tasks/{task_id}',
    description: 'Get one task by task_id.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID_PROP }, required: ['task_id'] },
    run: async (db, a) => {
      const task = await getTask(db, a.task_id);
      return task ? { ok: true, task } : taskNotFound(a.task_id);
    },
  },
  get_task_events: {
    rest: 'GET /api/tasks/{task_id}/events',
    description: 'Get a task\'s event log in seq order. Use after_seq as a cursor to fetch only newer events.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID_PROP,
        after_seq: { type: 'integer', description: 'Return events with seq greater than this (default 0).' },
        limit: { type: 'integer', description: 'Max rows (default 200, clamped to 1..500).' },
      },
      required: ['task_id'],
    },
    run: async (db, a) => {
      const data = await getTaskEvents(db, a.task_id, { after_seq: a.after_seq, limit: a.limit });
      return data ? { ok: true, ...data } : taskNotFound(a.task_id);
    },
  },
  get_task_resume: {
    rest: 'GET /api/tasks/{task_id}/resume',
    description: 'Get the resume/handoff packet for a task: status, latest result and review, recent messages, '
      + 'artifacts, open and resolved decisions, latest handoff, and block reason.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID_PROP }, required: ['task_id'] },
    run: async (db, a) => {
      const resume = await getResume(db, a.task_id);
      return resume ? { ok: true, resume } : taskNotFound(a.task_id);
    },
  },
  get_activity: {
    rest: 'GET /api/activity',
    description: 'Recent events across the whole hub, newest first (includes Team chat message bodies). '
      + 'Poll this to follow what the team is doing.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows (default 50, clamped to 1..200).' } },
    },
    run: async (db, a) => ({ ok: true, ...(await getActivity(db, { limit: a.limit })) }),
  },
  list_decisions: {
    rest: 'GET /api/decisions',
    description: 'List decisions requested of David, newest first. Optional state filter.',
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string', description: 'requested | resolved' } },
    },
    run: async (db, a) => ({ ok: true, ...(await listDecisions(db, { state: a.state })) }),
  },
  list_agents: {
    rest: 'GET /api/agents',
    description: 'Live agent status projection: context_health, work_state, current_task_id per agent.',
    inputSchema: { type: 'object', properties: {} },
    run: async (db) => ({ ok: true, ...(await listAgents(db)) }),
  },
  get_stats: {
    rest: 'GET /api/stats',
    description: 'Hub volume indicators: event totals, events today, tasks by status, open decisions, agent count.',
    inputSchema: { type: 'object', properties: {} },
    run: async (db) => ({ ok: true, stats: await getStats(db) }),
  },
};

/** Run one query by name. Returns the hub response envelope. */
export function runQuery(db, name, args = {}) {
  return QUERIES[name].run(db, args);
}
