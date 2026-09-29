-- 0001_schema.sql — hub v1 initial schema (D1 / SQLite compatible)
--
-- Design notes:
-- * `events` is the append-only authoritative history. Projections
--   (tasks, messages, results, reviews, decisions, handoffs,
--   artifact_refs, agents) are derived and rebuildable from it.
-- * Invariant: for task-scoped events, tasks.version == seq of the last
--   event for that task. Concurrency control piggybacks on the
--   UNIQUE(scope, seq) constraint: a stale writer's batch fails atomically.
-- * No foreign keys: keeps D1 batches simple and rebuild order-independent.
-- * Timestamps are INTEGER unix-milliseconds, always server-assigned.

CREATE TABLE IF NOT EXISTS events (
  event_id           TEXT PRIMARY KEY,
  task_id            TEXT,                       -- NULL only for workspace-level events
  seq                INTEGER NOT NULL,           -- server-assigned, monotonic per task scope
  event_type         TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  submitted_by       TEXT NOT NULL,              -- authenticated submitter; differs on relay
  created_at         INTEGER NOT NULL,           -- server timestamp (unix ms)
  caused_by_event_id TEXT,
  idempotency_key    TEXT NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  payload            TEXT NOT NULL,              -- JSON
  UNIQUE (actor_id, idempotency_key)
);

-- One linearization point per scope: ('', seq) covers workspace-level events.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_scope_seq
  ON events (COALESCE(task_id, ''), seq);
CREATE INDEX IF NOT EXISTS idx_events_task_seq
  ON events (task_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
  task_id                TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  goal                   TEXT NOT NULL,
  priority               TEXT NOT NULL DEFAULT 'normal',
  status                 TEXT NOT NULL DEFAULT 'pending',
  assignee               TEXT,
  deadline               TEXT,
  version                INTEGER NOT NULL DEFAULT 0,  -- == seq of last task event
  latest_result_event_id TEXT,
  latest_review_event_id TEXT,
  created_by             TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,   -- message | question | proposal
  body       TEXT NOT NULL,
  reply_to   TEXT,
  actor_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages (task_id, seq);

CREATE TABLE IF NOT EXISTS results (
  result_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  evidence   TEXT,            -- JSON, optional
  links      TEXT,            -- JSON array, optional
  actor_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_task ON results (task_id, seq);

CREATE TABLE IF NOT EXISTS reviews (
  review_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  outcome    TEXT NOT NULL,   -- accepted | rework
  notes      TEXT,
  actor_id   TEXT NOT NULL,   -- the reviewer
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews (task_id, seq);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  task_id     TEXT,            -- NULL for workspace-level decisions
  phase       TEXT NOT NULL,   -- requested | resolved
  question    TEXT,
  options     TEXT,            -- JSON array, optional
  resolution  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions (phase);

CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT,
  agent_id   TEXT NOT NULL,
  goal       TEXT NOT NULL,
  done       TEXT NOT NULL,    -- JSON array
  pending    TEXT NOT NULL,    -- JSON array
  key_context TEXT,
  refs       TEXT,             -- JSON array
  reason     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_refs (
  artifact_id TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL UNIQUE,
  task_id     TEXT,
  name        TEXT NOT NULL,
  mime_type   TEXT,
  uri         TEXT NOT NULL,
  sha256      TEXT,
  supersedes  TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  context_health  TEXT NOT NULL DEFAULT 'normal',  -- normal | watch | handoff-due
  work_state      TEXT NOT NULL DEFAULT 'idle',    -- idle | working | blocked | stalled
  current_task_id TEXT,
  version         INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
