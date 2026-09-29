---
id: 012
title: Deploy to David's Cloudflare account + verify live
state: pending
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
