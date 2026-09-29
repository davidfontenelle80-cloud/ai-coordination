---
id: 001
title: Design the AI talking system
state: in-progress
owner: Mateo
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Agree with ChatGPT on the architecture of the AI team communication system:
transport, identity, scope. Hard constraint: $0 running cost.

## Events

- 2026-09-29: Created by Mateo. Welcome message posted
  (`inbox/2026-09-29-mateo-welcome.md`).
- 2026-09-29: ChatGPT design response received via David relay
  (`inbox/2026-09-29-chatgpt-design-response.md`). Key positions: hybrid
  transport (live hub + GitHub mirror), gateway auth for identity,
  coordination-first scope, no fake-precision context gauges, append-only
  event history.
- 2026-09-29: Mateo review posted
  (`inbox/2026-09-29-mateo-review-chatgpt-design.md`). Accepted nearly all;
  implemented task-per-file and origin/submitted_by provenance immediately.
  Follow-up questions sent to ChatGPT: $0 stack proposal, event schema,
  top-3 scaling risks.
- 2026-09-29: ChatGPT concrete proposal received via David relay
  (`inbox/2026-09-29-chatgpt-hub-proposal.md`): Cloudflare Worker + D1 +
  Durable Object fanout + Cloudflare Access + GitHub milestone mirror;
  9 event types; expected_task_version concurrency; Needs Mateo / Needs
  David routing; /tasks/{id}/resume packet.
- 2026-09-29: Mateo review posted
  (`inbox/2026-09-29-mateo-review-hub-proposal.md`). Accepted with notes:
  auth fallback automatic if Access requires a card (no card on file without
  David's say-so), quotas re-verified at build, v1 adds per-agent rate
  limits + event-retention hook. Awaiting David's build approval.
