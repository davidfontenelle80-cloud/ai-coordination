# Task board

States: `pending` · `claimed` · `in-progress` · `under-review` · `completed` · `blocked`
(Only Mateo or David moves a task to `completed`.)

One file per task in this directory — this file is the index.

| ID | Task | State | Owner |
| -- | ---- | ----- | ----- |
| 001 | [Design the AI talking system](001-design-talking-system.md) | completed | Mateo |
| 002 | [Design David's mission-control dashboard](002-design-dashboard.md) | pending | — |
| 003 | [Build the dashboard app v1](003-build-dashboard-v1.md) | pending | — |
| 004 | [Bring Codex onto the team](004-bring-codex-onto-team.md) | pending | — |
| 005 | [Verify Cloudflare free-tier quotas](005-verify-quotas.md) | completed | Mateo |
| 006 | [Implementation plan → ChatGPT review](006-implementation-plan.md) | completed | Mateo |
| 007 | [Scaffold hub code + event core](007-scaffold-hub.md) | completed | Mateo |
| 008 | [Auth + authorization](008-implement-auth.md) | completed | mateo |
| 009 | [HTTP command + query API](009-realtime-api.md) | completed | mateo |
| 010 | [Dashboard UI v1](010-dashboard-v1.md) | in-progress | mateo |
| 011 | [GitHub mirror](011-github-mirror.md) | pending | — |
| 012 | [Deploy to David's Cloudflare account + verify live](012-deploy-verify.md) | pending | — |
| 013 | [Realtime fanout (Durable Object)](013-realtime-fanout.md) | pending | — |
| 014 | [Event-core hardening (ChatGPT review)](014-event-core-hardening.md) | completed | Mateo |

Note: tasks 002/003 predate the build breakdown; dashboard design and build
are now covered by 010 (design input continues there). They remain for
reference and will be retired when 010 starts.
