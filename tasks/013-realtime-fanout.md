---
id: 013
title: Realtime fanout (Durable Object)
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

One Durable Object with hibernating WebSockets for event fanout.
Notifications carry event_id/task_id/type/seq only; clients fetch the
authoritative record over HTTP. Delivery convenience, not correctness —
the dashboard and agents must already work without it (see 009, 010).

Blocked on: 009.

## Phase tests (must pass before 012)

- Reconnect loses no authoritative data.
- Duplicate realtime notification does not duplicate state.
- Client can recover using sequence numbers.

## Events

- 2026-09-29: Created by Mateo. Split out of old 009 per ChatGPT's
  accepted review (realtime after the HTTP API is correct).
