# ai-hub — coordination hub v1

Local scaffold. **No deploy in this phase** (task 007: event core only).

## Layout

```
hub/
  wrangler.toml            # Worker project config (local only; ids are placeholders)
  package.json             # npm test -> node --test worker/test/
  db/migrations/
    0001_schema.sql        # D1/SQLite schema: events (append-only) + projections
  docs/
    quota-verification-2026-09-29.md
  worker/src/
    index.mjs              # Worker entry placeholder (command handlers land in 009)
    event-core.mjs         # THE core: validate -> appendEvent -> projections -> rebuild
    sqlite-db.mjs          # local Db adapter (node:sqlite); D1 adapter comes at deploy
  worker/test/
    event-core.test.mjs    # phase tests (11 tests, all passing)
    claim-racer.mjs        # worker-thread helper for the claim-race test
```

## Event core design

- **Only `appendEvent()` writes** to `events` and projection tables. Command
  handlers (task 009) call it; nothing else touches these tables.
- **Db interface**: `queryOne`, `queryAll`, `batch([{sql, params}])`.
  `batch()` is the single linearization point — one atomic unit per append
  (event row + all projection statements). Locally this is
  `BEGIN IMMEDIATE/COMMIT`; at deploy it maps to D1 `db.batch()`.
- **Concurrency**: read phase (idempotency check, version read, seq compute)
  then one atomic write batch. The `UNIQUE(COALESCE(task_id,''), seq)`
  constraint makes a stale writer's batch fail atomically; on failure the
  core re-checks idempotency (retry -> return existing event) then the
  version (stale `expected_task_version` -> `VERSION_CONFLICT`).
- **Invariant**: `tasks.version == seq` of the last task-scoped event.
- **`expected_task_version`** is enforced only for task-scoped events
  (ignored for workspace-level events like `agent.status_changed`).
- **Projections are derived**: `rebuildProjections()` wipes projection
  tables and replays `events` in commit order. Tested to reproduce state
  exactly (see phase tests).
- **No event compaction in v1** (per accepted review): the event log stays
  authoritative; GitHub is milestone-only and sanitized.

## Running tests

```
cd hub && npm test
```

11 tests: schema/validation, idempotent retry (sequential + 4-thread race),
stale-version conflict, batch atomicity, 8-thread simultaneous-claim race
(exactly one winner), full 15-event lifecycle across all 9 event types,
projection rebuild equality, empty rebuild.

## What's next (later tasks)

- 008: auth + authorization (GitHub OAuth for David, bearer tokens for agents)
- 009: domain command handlers + read API (incl. `/tasks/{id}/resume`) on top
  of `appendEvent()`; simple rate protection; stable error contract
- 010: dashboard; 011: GitHub mirror; 012: deploy + live verification
