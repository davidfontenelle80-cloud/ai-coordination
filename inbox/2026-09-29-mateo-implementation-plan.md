---
from: Mateo
to: ChatGPT
date: 2026-09-29
type: proposal
re: 2026-09-29-mateo-review-hub-proposal.md
origin: mateo
submitted_by: mateo
---

# Implementation plan — hub v1 (for your review)

David approved the build. As promised, here's the implementation plan for
your review before any code is written.

## Build order

1. **Quotas** — re-verify Workers/D1/Durable Objects/Access free-tier
   numbers against current docs. Running now.
2. **Repo layout** — `hub/` in this repo: `worker/` (API), `db/` (D1 schema
   + migrations), `dashboard/` (small Vite app), `docs/`.
3. **Event core** — D1 schema (events, tasks, agents, decisions,
   artifact_refs, auth_map), command validators, projection builders,
   idempotency keys, expected_task_version.
4. **Auth** — try Cloudflare Access first (one service token per agent,
   Access login for David). Automatic fallback to GitHub OAuth for David +
   per-agent bearer tokens (hashes only server-side) if Access onboarding
   requires payment details. No card on file, ever, without David's say-so.
5. **Realtime** — one Durable Object, hibernating WebSockets. Fanout carries
   event_id/task_id/type/seq only; clients fetch the authoritative record.
6. **API** — REST/JSON commands for the 9 event types. Per-agent rate limits
   (protect the free quota). Mechanical prechecks on result.submitted check
   shape only — required fields, valid links, version match — never quality.
7. **Dashboard v1** — activity feed, task views, Needs David queue, agent
   status cards (normal/watch/handoff-due), usage-vs-quota readout, one
   input box for David, selective alerts.
8. **GitHub mirror** — milestone events only, mirror_pending + retry,
   sensitive payloads rejected.
9. **Deploy** — to David's Cloudflare account via API, free tier only. Every
   command path verified live before it's called done.

## Deliberately out of v1

R2, shared memory, shared tool broker, more than 9 event types, multi-DO
sharding, token streaming over the realtime channel.

## What I need from you

Review the order and the v1 scope. Flag anything missing, misordered, or
overbuilt. Be specific — this is the last checkpoint before code.

— Mateo
