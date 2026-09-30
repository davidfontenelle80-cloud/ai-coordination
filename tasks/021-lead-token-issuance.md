# Task 021 — Lead-token issuance from the dashboard

## Problem
David wants to hand the coordinator ("lead") role to different agents on
different projects. Today that is impossible from the dashboard: the Tokens
screen hardcodes `role: 'agent'` on issuance (least privilege, task 016/018),
and there is no `mateo`-role identity at all — the "Mateo watcher token" is
agent-role (`mateo-watcher`). Consequence: only David (GitHub session) can
`createTask`/`setPriority`; Mateo cannot do the lead job without routing
through David.

## Scope
Dashboard UI only. The server already accepts and validates
`role: 'mateo' | 'agent'` (`issueAgentToken` throws `AUTH_BAD_ROLE` /
`AUTH_ROLE_MISMATCH` otherwise) — no server change needed.

## Changes (`hub/worker/src/dashboard.mjs`)
1. `AGENTS_MENU`: add `{ id: 'mateo', label: 'Mateo (lead seat)' }` so David
   can mint the coordinator seat.
2. Issue-token flow becomes two steps: pick agent → pick role.
   - New `menuStep = 'role'` rendering two buttons: **Agent** (standard team
     seat) and **Lead** (coordinator — can create tasks, set priorities).
   - `chatSel.role` carries the pick (default `'agent'`); shown as a chip;
     clearable.
3. `sendChat` posts `{ agent_id, role }` with the chosen role instead of the
   hardcoded `'agent'`. Plaintext still shown once on the issued-token
   screen; never in the composer.
4. Keep the OAuth ceremony agent-only (no change): lead tokens are issued
   by David alone, from this screen.

## Not in scope
- Per-project lead assignment (the hub has no projects concept yet).
- Renaming the internal `'mateo'` role value — UI says "Lead", wire keeps
  `'mateo'`.
- ChatGPT tie-in (separate work).

## Acceptance
- New/updated `dashboard.test.mjs` cases: role step renders after agent pick;
  Lead posts `role: 'mateo'`; default/ Agent posts `role: 'agent'`; existing
  issuance tests still pass.
- Full suite green (`node --test worker/test/*.test.mjs`).
- Deployed; live dashboard issuance walkthrough verified by David tap-through
  (Mateo cannot complete the David-only tap).
