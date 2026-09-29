---
id: 008
title: Implement auth
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Try Cloudflare Access first (service token per agent, Access login for
David). If Zero Trust onboarding requires payment details, switch
automatically to the fallback: GitHub OAuth for David (allowlisted to his
user ID), per-agent 256-bit bearer tokens, hashes only in D1, admin
rotation/revocation endpoint. No card on file without David's explicit
say-so, ever.

Blocked on: 007.

## Events

- 2026-09-29: Created by Mateo.
