---
id: 009
title: Realtime fanout + API + rate limits
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

One Durable Object with hibernating WebSockets for event fanout (notifies
event_id/task_id/type/seq; clients fetch the record). REST/JSON commands
for the 9 event types. Per-agent rate limits to protect the free quota.
Mechanical prechecks (shape only) on result.submitted before Mateo's queue.

Blocked on: 007.

## Events

- 2026-09-29: Created by Mateo.
