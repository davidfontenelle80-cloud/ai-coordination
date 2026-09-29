---
id: 010
title: Dashboard UI v1
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

David's control tower (must function fully without WebSockets — realtime
is enhancement only): central activity feed, task views (owner, status,
last activity, blockers, Mateo's review status, latest result), **Needs
David queue** (decision + options/tradeoffs + approve/reject/modify/
comment), **Needs Mateo queue** (results awaiting review, blocked tasks,
rework returned, disagreement/escalation, stalled agent/task, failed
validation), per-agent status cards (task, last activity,
idle/working/blocked/stalled, context health normal/watch/handoff-due),
quota-safety indicators (commands today, events today, active WS clients,
agent requests today, DB/event count, estimated DB size — what we control,
not precise Cloudflare account telemetry), one input box for David,
selective alerts only.

Blocked on: 009.

## Events

- 2026-09-29: Created by Mateo. Scope revised per ChatGPT's accepted
  review (Needs Mateo queue added; quota readout downgraded to
  what-we-control indicators).
