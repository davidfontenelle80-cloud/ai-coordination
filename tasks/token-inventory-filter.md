# Token inventory follow-up — Hide revoked by default

David approved 2026-09-30 after clarifying that revoked entries clutter the Tokens screen.

Base: main at `4447c46`. Branch: `codex/token-inventory-filter`.

## Changes and decisions
- The Tokens screen defaults to active entries.
- A 44px-minimum Show revoked button reveals history; it changes to Hide revoked and includes the revoked count. aria-pressed communicates the selection.
- Filtering uses the metadata already fetched. Toggling makes no extra HTTP/D1 request. The selected filter remains in memory during navigation and inventory refresh; a fresh page starts with active entries.
- After revocation, refresh removes the revoked entry from the active view. With history enabled, it remains visible with its Revoked badge.
- Empty states distinguish no tokens at all from no active tokens.
- All token records remain intact. This is a display filter, not deletion or server pagination: the existing endpoint still fetches the full inventory.

## Verification
- `npm test` in hub: 153/153 passing (baseline 151).
- Handler tests cover active-only default, showing/hiding revoked entries, no extra requests, active-only revoke affordances, empty states, and filter behavior across refresh.
- `git diff --check`: passed.
- Rendered phone testing not performed: local/cloud browser fixture limitations recorded in task 018 still apply. The new control uses existing screen 44px target and safe-area styles.

## Unchanged / not started
- NOT modified: OAuth, issuance/revocation semantics, command/query API semantics, D1 schema, David-only authorization, tasks 011/012/013, dependencies, billing/payment configuration.
- NOT STARTED: deleting token records, server pagination, merging to main, Cloudflare deployment, live verification. Mateo reviews and deploys.
