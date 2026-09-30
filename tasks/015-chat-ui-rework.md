---
id: 015
title: Chat-style thread UI + iPhone home-screen icon
state: in-progress
owner: mateo
created: 2026-09-30
updated: 2026-09-30
---

## Goal

Two David-approved improvements to the hub dashboard (task 010), built as
one phase:

**A. Chat thread UI.** Rework the cramped bottom command bar into a
text-message-style thread: David's messages right-aligned in accent
bubbles; agent messages left-aligned with avatar (initials, per-agent
color) + name header on the first message of each consecutive group;
timestamps; day dividers; flat chronological thread. Composer pinned at the
bottom with an auto-growing textarea (16px minimum so iOS Safari never
zoom-focuses), a 44×44pt round Send button, and a "/" button opening a
slash-command popup anchored above the input. Existing command semantics
are kept: message-a-task + task target selector becomes a removable
task-target chip above the textarea. iPhone mechanics (the actual bug, not
just styling): `viewport-fit=cover`, `100dvh` layout, composer offset via
the `visualViewport` API for keyboard height plus
`env(safe-area-inset-bottom)` padding, Enter inserts a newline on mobile
(Send button sends), draft persisted in `sessionStorage`, in-flow typing
indicator ("Mateo is reviewing…") cleared on response/error/~10s timeout,
auto-scroll only when already near the bottom (otherwise a "↓ new messages"
pill), and the 15s poll must never steal composer focus or wipe the draft
(re-renders scoped to the message list).

**B. Home-screen icon.** Wire the approved 3D icon
(`hub/assets/ai-hub-icon-3d.png`) for iPhone: opaque 180×180
apple-touch-icon, 192×192 + 512×512 manifest icons, a maskable 512 variant
with padding, and a favicon — all served from the Worker, with the
manifest and Apple meta tags in the dashboard head.

Out of scope (NOT started): realtime fanout (013), GitHub mirror (011),
agent bearer credentials, any auth/API/D1-schema change.

## Decisions

- 2026-09-30: Thread renders `message.posted` events from the existing
  `/api/activity` feed (chronological) plus optimistic local echoes of
  David's sends; no new API endpoint. Authorship keys on `actor_id`
  (`'david'` = right-aligned).
- 2026-09-30: Author colors pinned for known ids (David blue, Mateo
  green, ChatGPT light green, Claude orange); unknown agents hash into a
  fixed palette.
- 2026-09-30: Icon PNGs are base64-embedded in a new `worker/src/icons.mjs`
  module (same "no fs, no build step" pattern as the dashboard literals)
  and served David-only like the other dashboard assets. Bundle size is
  watched against the 1 MiB free-plan script budget.
- 2026-09-30: Enter-to-send is desktop-only (fine pointer); on touch
  devices Enter inserts a newline and the Send button sends.
- 2026-09-30: `/api/activity` (`getActivity` in worker/src/queries.mjs) now
  SELECTs `payload` so thread message bodies are reachable — additive field
  only, no schema or contract change. All other "do NOT touch" items
  (auth, D1 schema, 011, 013, agent credentials) remain untouched.
- 2026-09-30: `renderThread()` re-render is signature-gated and never
  touches the composer DOM — the 15s poll cannot steal focus or wipe
  David's draft.
- 2026-09-30: Slash-menu buttons stopPropagation on click. renderMenu()
  replaces innerHTML, detaching the clicked button; without this the
  document-level outside-click handler sees a detached target and instantly
  hides the task-picker step (caught by the headless screenshot test,
  fixed same session).

## Events

- 2026-09-30: Created by Mateo. David approved the build ("go build it")
  after reviewing the 3D icon draft and the chat-interface research.
