---
id: 012
title: Deploy to David's Cloudflare account + verify live
state: in-progress
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Full integration/security/concurrency test pass, then deploy the hub to
David's Cloudflare account via API (free tier only). Live verification of
every command path before it's called done: auth, task lifecycle, realtime
fanout, dashboard load, mirror write. No deploy without green checks.
David's standing rule: he is told what was deployed and where. Never
upgrade the account to Workers Paid without his explicit approval (that
switches products to allowance-plus-overage billing).

Blocked on: 008, 009, 010, 011, 013.

## Events

- 2026-09-29: Created by Mateo. Dependencies updated per ChatGPT's
  accepted review.

- 2026-09-29 ~22:00 EDT: Deployed by Mateo (David approved).
  Worker `ai-hub` live at https://ai-hub.davidfontenelle80.workers.dev
  (Workers Free, $0). D1 database `ai-hub`
  (afeb9eaa-d2f5-4ca6-b814-caefae539fd4) created; migrations 0001 + 0002
  applied (15 tables). Deploy token was David-pasted, transient-only,
  never stored; set to expire 2026-10-01.
  Live-verified: /api/stats -> 401 AUTH_REQUIRED, / and /dashboard -> 302
  to /auth/github/login, /auth/github/login -> 400 AUTH_NOT_CONFIGURED
  (expected until GitHub OAuth secrets are set). workers.dev had to be
  enabled explicitly via the API (it was off for the new script).
  Remaining: GitHub OAuth app (David creates, callback
  https://ai-hub.davidfontenelle80.workers.dev/auth/github/callback),
  then set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET and verify David login
  + an authenticated D1 read/write round-trip.
