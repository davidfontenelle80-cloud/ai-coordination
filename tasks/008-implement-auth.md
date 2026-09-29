---
id: 008
title: Auth + authorization
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

No Cloudflare Access — quota verification confirmed Zero Trust onboarding
requires a card on file. Build from the start: GitHub OAuth for David
(allowlisted by **numeric user ID**, not username; state validation; secure
callback; Secure + HttpOnly + SameSite session cookie; CSRF protection for
state-changing dashboard actions) and per-agent bearer tokens
(`token_id.secret` format; store token_id, agent_id, secret_hash,
created_at, last_used_at, revoked_at; plaintext shown once, never stored;
rotate-before-revoke). All OAuth/signing secrets in Worker secret storage
only — never GitHub, never plaintext D1.

**Authorization matrix** (enforced centrally, defined before any command
handler):

- David: everything; resolve consequential decisions; override task
  state/assignment.
- Mateo: create/assign tasks; review results; accept/reject work; complete
  tasks; resolve ordinary coordination conflicts.
- Agent: claim permitted work; post messages; submit results; post handoff;
  update own status; attach artifact refs.

An authenticated agent token must never reach a Mateo-only or David-only
capability.

Blocked on: 007.

## Phase tests (must pass before 009 starts)

- Wrong bearer token rejected; revoked token rejected.
- Agent cannot perform a Mateo action (e.g. recordReview accept).
- Mateo cannot impersonate a David decision (resolve consequential).
- David override works.

## Events

- 2026-09-29: Created by Mateo. Scope revised per ChatGPT's accepted
  review (authz matrix, locked auth details).
