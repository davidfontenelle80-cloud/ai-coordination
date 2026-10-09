# Pilot decision record — #1 Cloudflare Preview Workflow

- **Date:** 2026-10-09
- **Decision owner:** David
- **Verifier/release reviewer:** Mateo
- **Implementation:** ChatGPT, review branch `chatgpt/cloudflare-preview-pilot-20261009`
- **Decision:** Commit a manual GitHub Actions preflight referencing the GitHub Environment `cloudflare-preview`. Do **not** deploy, schedule, merge, or activate the AI team wake-up automation.
- **Status:** Proposed for Mateo verification; not live, not an approved production release.

## Boundaries

1. The GitHub workflow `.github/workflows/01-cloudflare-preview-pilot.yml` has **only** `workflow_dispatch` and requires the exact `PREFLIGHT_ONLY` dispatch input. No push, cron, webhook, or automatic trigger.
2. It runs the hub Node.js tests and checks **presence only** of `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the *cloudflare-preview* Environment. Names are conventional assumptions; Mateo must confirm them. Values must never be logged or committed. Secrets' presence was reported by David, not independently verified by ChatGPT.
3. The existing `hub/wrangler.toml` is a local scaffold with placeholder D1 identifiers. No Wrangler deploy or migration is attempted; no GitHub Pages publishes; no email or Hub task is triggered.
4. Cost boundary: $0 approved incremental cost. Stop rather than introduce paid infrastructure.
5. The previously paused AI team wake-up (#1 in an older automation menu) **remains ON HOLD**. This pilot does not authorize it.

## Pilot verification and acceptance criteria

- [ ] Mateo reviews the diff and confirms this is the intended "#1 workflow" before merging.
- [ ] Mateo confirms environment access, required review protection, and the actual names of the environment secrets; no secret material exposed.
- [ ] Workflow YAML passes validation on GitHub after review; only a manually dispatched `PREFLIGHT_ONLY` run is allowed.
- [ ] `npm test` completes successfully inside `hub` on the run.
- [ ] Secret-presence check passes without printing values.
- [ ] A nonmatching input does not execute the job.
- [ ] No Cloudflare code deployment, D1 mutation, external messaging, or paid service occurs.
- [ ] Mateo writes an independent verification record before status may become "complete".

## Evidence at handoff

- GitHub connector verified `ai-coordination` exists, default branch `main`; the source had no `.github/workflows` directory on the default branch before this change.
- No run or test result from GitHub Actions is claimed. This document records an intended pilot and current safeguards only.
