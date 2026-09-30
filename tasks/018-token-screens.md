# Task 018 — Instant commands and token screens

Base: main at `45f9755`. Branch: `codex/task-018-token-screens`.

## Decisions and changes
- All slash-menu entries declare their input requirements. Entries needing text, a task, or an agent retain the picker/chip/send flow. Manage agent tokens needs none and navigates on tap without changing or sending a draft.
- Replace the token overlay with full Tokens and Token issued screens. A small registry, enter/leave hooks, in-memory back stack, and per-screen scroll positions allow future screens without a framework or dependency.
- Tokens displays the existing complete inventory: display name, agent_id, token_id, issued date/by, last-used date or never, and Active/Revoked badge. Active rows use the existing David-only revoke endpoint with two-tap inline confirmation. Refresh after revoke does not add a back-stack entry. Load/revoke network errors allow retry; stale inventory responses are ignored.
- Issued token has a readonly textarea, Copy token (clipboard API with textarea fallback), View all tokens, visible Back and Done. Plaintext never enters the composer or draft storage. Leaving removes the token and its handlers; the issued screen is never retained on the back stack.
- Screen headers and bodies include safe-area padding; new screen buttons have 44px minimum height/width; token metadata wraps and action buttons wrap on narrow screens. Existing dashboard polling and draft handling stay in place.

## Validation
- Baseline: 144/144 tests passing.
- Extended suite: 151/151 tests passing (`npm test` in hub).
- Six dependency-free tests execute the actual embedded dashboard handlers for instant taps, input-dependent flows, navigation/inventory, issued copy/done/plaintext cleanup, inline revoke and stack behavior, and screen markup/targets/safe areas.
- Additional HTTP test checks active → revoke → revoked → bearer 401 and checks responses for the issued plaintext, secret portion and stored hash. Existing David-only 401/403 tests remain green.
- Phone viewport browser verification: NOT COMPLETED. No local browser is installed; Playwright's download returned an invalid archive. The cloud browser rejected the isolated data-URL fixture under its URL security policy. No workaround was attempted. Automated markup/CSS checks verify safe-area rules and 44px targets, but do not substitute for rendered iPhone-width verification. Mateo should run a 390px browser smoke check before deployment: tap Manage (without Send), Back, issue for an agent, Copy/Done, issue again → View all tokens → Back, then Revoke twice and verify the revoked badge. Check long IDs and names at 320px for overflow.
- No new endpoint, migration, dependency, framework, paid resource, billing profile, or payment method.

## Explicit exclusions
- NOT modified: GitHub OAuth flow; issuance semantics; command/query API semantics; D1 schema; dashboard David-only policy; tasks 011/012/013.
- NOT STARTED: Agents screen; changes to tasks 011/012/013; live Cloudflare deployment or live verification; merging to main.
- Mateo retains deployment and live verification after review.
