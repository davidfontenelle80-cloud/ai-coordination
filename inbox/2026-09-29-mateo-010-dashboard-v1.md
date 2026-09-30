# Mateo — task 010 dashboard v1 implementation (2026-09-29)

David approved starting the dashboard ("Go ahead", 2026-09-29 ~21:37 EDT).

## What was built

David's control tower, served by the Worker itself (no WebSockets —
task 013 is enhancement only; the page polls every 15s):

- `GET /` and `GET /dashboard` → dashboard HTML; `GET /dashboard/app.js`,
  `GET /dashboard/styles.css` → assets. All **David-only**: unauthenticated
  browsers 302 to `/auth/github/login`; authenticated non-David principals
  get 403.
- `GET /api/stats` → quota/what-we-control indicators (events_total,
  events_today, tasks_total, tasks_by_status, decisions_open,
  agents_count). Any authenticated principal.
- New `setPriority` command (task.changed field=priority; core already
  supported it). Coordinator-only: David + Mateo, ordinary agents get
  FORBIDDEN. Command surface is now 13.
- Dashboard UI (`hub/worker/src/dashboard.mjs`, template literals so it
  imports identically in node tests and the esbuild bundle):
  - Needs David queue: pending decisions with options, approve / reject /
    resolve-as-modified / comment.
  - Needs Mateo queue: results awaiting review (accept / request rework),
    blocked tasks (unblock), stalled agents.
  - Task list with status/assignee filters; task detail dialog driven by
    the `/resume` packet (state, blocker, result, review, messages,
    decisions, artifacts, handoff) with actions (message, start, block,
    priority, request decision).
  - Agent status cards, activity feed, alert banner (blocked tasks, stalled
    agents, decisions awaiting David), quota chips in the header.
  - David's command bar: message task / create task ("title | goal") /
    set priority / request decision.
  - All server data HTML-escaped client-side.

## Verification

- 123/123 tests pass, five consecutive full-suite runs (was 115/115).
- New tests: setPriority builder/authz/validation; dashboard route gating
  (302/200/403 + content types); /api/stats shape and counters;
  setPriority end-to-end over HTTP as David + 403 for an agent token.
- Embedded app JS syntax-checked (`node --check`); resume/activity/
  decisions field shapes verified against the real query contracts.

## Notes for later tasks

- Deploy (012) still pending: GitHub OAuth env (GITHUB_CLIENT_ID/SECRET,
  DAVID_GITHUB_ID) must be set on the Worker for David's login to work
  live; the dashboard was verified through the real fetch handler with a
  stubbed GitHub flow only.
- Realtime fanout (013) will replace the 15s polling.

— Mateo
