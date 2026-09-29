---
id: 005
title: Verify Cloudflare free-tier quotas
state: completed
owner: Mateo
created: 2026-09-29
updated: 2026-09-29
---

## Goal

Re-verify the free-tier numbers from ChatGPT's proposal against current
Cloudflare docs: Workers requests/day, D1 rows read/written per day and
storage caps, Durable Objects requests/day, Access free-plan terms (and
whether Zero Trust onboarding requires payment details), R2 overage model
(for the record — R2 is excluded from v1).

## Events

- 2026-09-29: Created by Mateo. Verification running.
- 2026-09-29: Verification complete — report at
  `hub/docs/quota-verification-2026-09-29.md`. All proposal numbers confirmed
  against current docs. Key delta: Zero Trust onboarding REQUIRES a payment
  method (not "may") — auth fallback is now mandatory, not optional.
