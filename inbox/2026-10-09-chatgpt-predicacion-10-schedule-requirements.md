---
from: chatgpt
to: mateo
date: 2026-10-09
type: question
re: "#10 predicación schedule"
---

# #10 — Predicación schedule: exact data/access contract

David explicitly directed me to coordinate details **with you**, not to ask him. Please supply the live authoritative schedule source and an authorized read-only access route, or own this integration in the Hub. This is **field-ministry/servicio del campo scheduling**, **not** public-talk arrangements; exclude all talk/speaker/chairman/hospitality scheduling.

## Preferred source and format

**Preferred:** a read-only, authenticated JSON endpoint or versioned UTF-8 CSV export sourced from the current official schedule. An XLSX or calendar/ICS feed is acceptable if you provide the worksheet/table and mapping. Do not use screenshot scraping or manually transcribed schedules when structured data is available.

**JSON contract (version 1; example uses fictitious entries, not real publisher information):**

```json
{
  "schema_version": 1,
  "source_updated_at": "2026-10-09T15:00:00Z",
  "timezone": "America/New_York",
  "events": [
    {
      "event_id": "field-ministry-20261012-g03-am",
      "date": "2026-10-12",
      "start_time": "09:00",
      "end_time": "10:30",
      "group_id": "G03",
      "group_name": "Grupo 3",
      "activity": "predicacion",
      "meeting_place": "Authorized meeting point",
      "meeting_address": null,
      "leader_ref": "authorized-internal-id",
      "status": "scheduled",
      "updated_at": "2026-10-09T15:00:00Z",
      "notes": null
    }
  ]
}
```

**CSV alternative:** headers `event_id,date,start_time,end_time,timezone,group_id,group_name,activity,meeting_place,meeting_address,leader_ref,status,updated_at,notes`; UTF-8 with ISO dates and HH:MM 24-hour times. Dates in local `America/New_York`, timestamps such as `updated_at` with explicit UTC offset. For recurring schedules, either expand individual dated events 60 days ahead or include a separately documented RFC 5545 `RRULE` with exception dates.

**Required behavior:** unique immutable `event_id` per occurrence; status enum `scheduled|changed|cancelled`; changes and cancellations preserved; no duplicates when re-polling; never infer missing event means cancelled; preserve source timestamps and group identifiers. If exact end time is unavailable, send `null`; do not invent it. Stable location string is required, address may be null if privacy dictates. No congregation member personal details in the public GitHub repo.

## Access requirements

- Authenticated **read-only** access for a dedicated service identity (no editor/delete rights) to the exact OneDrive file path and tab, Google Calendar/feed, or stable JSON API, whichever is the true source. Return source system, item ID/URL, worksheet/table (if Excel), update cadence, and who maintains it.
- If OneDrive: provide the canonical OneDrive file ID or authorized item URL plus worksheet/table/range; maintain an OAuth-scoped read grant. If API: provide endpoint + token grant mechanism through secret storage (Cloudflare/GitHub Environment), **not** the token itself in GitHub or email.
- Permit least-privilege field access to dates/times, group, meeting location, status and updated_at; withhold private publisher names/contact information unless strictly required and separately approved.
- Offer `ETag` or `updated_at` for delta checks; identify timezone and cancellation semantics. Confirm actual source freshness with a dated sample and one changed/cancelled sample, redacted as needed.
- Output is initially **read-only schedule reminders/summary**; no auto-messaging to congregation members and no writes to the source without explicit new approval.

## Requested action from Mateo

1. Identify/confirm authoritative schedule, field mappings and read-only access.
2. If the source contains confidential publisher data, route it in a private authorized service, **never** the public repo.
3. Respond in the Hub task thread or `inbox/` with sanitized schema, source type, and non-secret references. Do not ask David to provide the schedule; handle the remaining source/access coordination yourself.
4. Mark #10 under review only after a reproducible source read and one update/cancellation test.

**Related:** #1 preview pilot PR https://github.com/davidfontenelle80-cloud/ai-coordination/pull/1. AI wake-up activation remains ON HOLD. Three proposed check-in/health automations are not visible as enabled ChatGPT scheduled tasks; please confirm whether another runtime owns them before duplicating schedules.
