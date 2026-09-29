---
id: 007
title: Scaffold hub code + event core
state: completed
owner: Mateo
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Scaffold `hub/` in this repo: Worker project, `db/` D1 schema + migrations,
event core (events table, projection builders, task versions, idempotency
keys, expected_task_version), and the **projection rebuild test**: empty
projections + full event stream must reproduce current state. Event append
and projection update are atomic. No deploy.

Per ChatGPT's accepted review: the public surface is **domain commands**,
not events — agents never create events directly. (Command handlers come in
009; the core exposes the internal append/projection functions they call.)

## Phase tests (must pass before 008 starts)

- Idempotent retry creates exactly one event.
- Stale expected_task_version returns a conflict.
- Simultaneous claims produce exactly one winner.
- Projections match event history (rebuild test).

## Events

- 2026-09-29: Created by Mateo. ChatGPT's plan review accepted; scope
  revised. Scaffold underway.
- 2026-09-29: Subagent delivered scaffold (commit 3b7c9d5, local only):
  schema, event-core.mjs, sqlite-db.mjs, wrangler scaffold, 11/11 tests.
- 2026-09-29: Mateo reviewed every file and ran the suite independently
  (11/11 pass). Found a real bug the tests missed: workspace-level events
  (task_id NULL) always computed seq=1, so the second one threw on the
  UNIQUE(scope, seq) index. Fixed (sequence from MAX(seq) of task-less
  events + lost-race retry), added 2 regression tests (13/13 pass, stable
  over 4 runs), removed a dead duplicate case. Committed as review fix and
  pushed (9132c6a). Details:
  `inbox/2026-09-29-mateo-review-scaffold.md`.
- 2026-09-29: Task complete. Awaiting ChatGPT's review of the event core
  before 008 (auth) begins.
- 2026-09-29: Scaffold complete. Built: wrangler.toml (local-only,
  placeholder ids), db/migrations/0001_schema.sql (events append-only +
  8 projection tables), worker/src/event-core.mjs (validate/appendEvent/
  projections/rebuildProjections; atomic batch = linearization point;
  UNIQUE(scope,seq) + UNIQUE(actor_id,idempotency_key); version==seq
  invariant), worker/src/sqlite-db.mjs (local node:sqlite Db adapter),
  worker/src/index.mjs (501 placeholder; handlers land in 009),
  worker/test/ (11 tests). All phase tests pass 4/4 runs:
  idempotent retry (sequential + 4-thread race) -> exactly one event;
  stale expected_task_version -> VERSION_CONFLICT, nothing written;
  8-thread simultaneous claim -> exactly one winner;
  15-event lifecycle across all 9 types -> rebuild reproduces projections
  exactly. No deploy performed (per task constraints).
