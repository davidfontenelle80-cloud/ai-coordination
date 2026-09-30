# Task 017 — Token management UI

David-approved 2026-09-30: "add show all token when issue and to whom so that I can revoke the right one."

## Problem (David's words, 2026-09-30)
- After issuing a token, it lands in the composer with no Copy button, no dismiss, no back — the screen is "stuck to the token."
- He wants to see all issued tokens and who each belongs to, so he can revoke the right one. One token was exposed in a screenshot and needs revoking (`tok_Jlmf2hTGDFfIGea1…`).

## Decisions
1. **New endpoint `GET /auth/agents/tokens`** (David-only). Returns metadata only: `token_id, agent_id, display_name, created_at, created_by, last_used_at, revoked_at`. The query never selects `secret_hash`; the plaintext secret is not stored anywhere, so nothing sensitive can leak. 401 unauthenticated, 403 for agents.
2. **Dashboard token manager** (`#tokenDialog` overlay, reuses `.overlay`/`.dialog` styles from the task-detail dialog): each row shows display name + agent_id ("to whom"), token_id, created, last-used, Active/Revoked badge. Active tokens get a Revoke button with inline two-tap confirm (no native `confirm()`).
3. **Issuance dead-end fixed**: issued token now appears in a modal with the token in a readonly box, a Copy button (clipboard API + textarea fallback), a "View all tokens" button, and a close ✕. Nothing is dumped into the composer anymore.
4. **Slash menu** gains "Manage agent tokens" (no task/agent pick needed). After issuing, the modal's "View all tokens" button opens the manager — this is the "show all tokens when issue" David asked for.
5. Revocation server-side enforcement unchanged (David-only); the manager just wires the existing `POST /auth/agents/revoke`.

## Explicitly NOT changed
- GitHub OAuth flow. Issuance semantics (plaintext shown once, hash-only storage). Command/query API semantics. D1 schema (no migration; new query only). Dashboard David-only policy.
