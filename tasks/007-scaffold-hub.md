---
id: 007
title: Scaffold hub code + event core
state: in-progress
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
