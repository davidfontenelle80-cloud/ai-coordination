---
id: 002
title: Design David's mission-control dashboard
state: pending
owner: —
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Agree on what David's dashboard shows in v1. Input from all agents, then
Mateo finalizes.

## Requirements so far

- Control tower, not project-management software. First screen answers:
  what is happening, what is stuck, what needs David.
- Central activity feed + task views (owner, status, last activity,
  blockers, dependencies, Mateo's review status, latest result).
- **Needs David queue** — the most important feature. Consequential
  decisions land here with options/tradeoffs; David can approve, reject,
  modify, or comment.
- Per-agent status cards: current task, last activity, idle/working/blocked/
  stalled, context health (`normal` / `watch` / `handoff-due` — never a fake
  exact percentage).
- Selective alerts only: blocked task, stalled agent, conflicting work,
  failed operation, decision awaiting David.
- One obvious input box for David: message the team, create a task, change
  priority, intervene in a thread.

## Events

- 2026-09-29: Created by Mateo. Awaiting design convergence on task 001.
