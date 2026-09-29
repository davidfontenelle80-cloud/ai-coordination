# Cloudflare Free-Tier Quota Verification — 2026-09-29

Checked against current Cloudflare docs (developers.cloudflare.com) and
multiple independent guides updated within the last ~30 days. Purpose: verify
the numbers in ChatGPT's hub proposal before build.

## 1. Workers Free — requests/day

- **Current docs:** 100,000 requests/day. 10 ms CPU per invocation. Hard stop
  on free — no overage, requests fail past the cap. Resets 00:00 UTC.
- **Proposal claimed:** 100,000 requests/day.
- **Verdict: MATCH.** No delta.

## 2. D1 — rows read/written, storage, overage behavior

- **Current docs** (developers.cloudflare.com/d1/platform/pricing, read
  directly 2026-09-29):
  - Rows read: 5 million / day (free)
  - Rows written: 100,000 / day (free)
  - Storage: 5 GB total per account (free); 500 MB max per database
  - Free limits reset daily at 00:00 UTC
  - **Overage behavior (official FAQ):** "When your account hits the daily
    read and/or write limits, you will not be able to run queries against D1.
    D1 API will return errors to your client indicating that your daily limits
    have been exceeded." Storage cap: must delete/clean up before inserting
    more. Paid tier is what removes limits / bills overages.
- **Proposal claimed:** 5M read / 100K written / 5 GB total / 500 MB per DB /
  hard-fail on exhaustion.
- **Verdict: MATCH on all points**, confirmed from the primary source. No delta.
- **Design note:** an index adds one extra written row per insert on the
  indexed column — index the columns we filter on (task_id, created_at) and
  the write budget stays comfortable.

## 3. Durable Objects — free requests/day, hibernating WebSockets

- **Current docs** (developers.cloudflare.com/durable-objects/platform/pricing):
  - Requests: 100,000 / day (free). Includes HTTP requests, RPC sessions,
    WebSocket messages (incoming WS messages billed 20:1), alarm invocations.
  - Duration: 13,000 GB-s / day (free). Objects idle but hibernation-eligible
    are **not billed for duration** — hibernating WebSockets are effectively
    zero-cost while idle.
  - Free plan supports SQLite storage backend only (fine — the fanout DO
    needs no persistent storage).
  - "If you exceed any one of the free tier limits, further operations of
    that type will fail with an error." Daily limits reset 00:00 UTC.
- **Proposal claimed:** 100,000 requests/day on free.
- **Verdict: MATCH.** One addition the proposal didn't mention: the 13,000
  GB-s/day duration cap. Impact: none for our design — the DO does fanout
  only (no storage, no compute), and hibernation means idle connections cost
  nothing. A single workspace DO will use a tiny fraction of both meters.

## 4. Cloudflare Access / Zero Trust Free — terms, service tokens, card requirement

- **Current state (multiple independent setup guides, all updated Sep 2026):**
  - Free for up to 50 users — confirmed.
  - Service tokens (per-agent client ID + secret, individually revocable)
    — confirmed, designed for automated systems.
  - **Payment details: REQUIRED, not "may be".** Three independent recent
    guides agree: Zero Trust onboarding asks for a credit card even on the
    Free plan ("Payment method required even for free tier"; "Ensure you
    have a credit on file. You can't proceed without this, even though Zero
    Trust is free for 50 users"). It is for fraud prevention and is not
    charged unless you exceed 50 users — but a card on file is a card on file.
- **Proposal claimed:** free <$50 users; onboarding "may require" payment details.
- **Verdict: MATCH on terms, UPGRADE on the caveat** — the card requirement
  is confirmed, not hypothetical.
- **Impact on the $0 constraint:** Mateo's review decision stands and is now
  mandatory, not optional — **use the fallback auth** (GitHub OAuth for David,
  per-agent 256-bit bearer tokens, hashes server-side, rotation/revocation
  via admin endpoint). Do not start Zero Trust onboarding; no card goes on
  file. Access can be revisited later only with David's explicit approval.

## 5. R2 — free allowance and overage model (for the record; excluded from v1)

- **Current:** 10 GB-month storage, 1M Class A ops/month, 10M Class B
  ops/month free; $0 egress. Overages: $0.015/GB-month storage,
  $4.50/million Class A, $0.36/million Class B.
- **Proposal claimed:** generous free allowance but defined paid overages.
- **Verdict: MATCH.** Unlike Workers/D1/DO (hard-fail on free), R2 has real
  paid overages — excluding it from v1 was the right call. Revisit only with
  explicit billing approval.

## Overall $0-constraint assessment

- At the designed scale (a handful of agents, hundreds of requests/day), the
  system sits orders of magnitude below every free cap. The constraint is not
  fragile.
- **Billing safety rule:** with no payment method attached to the account,
  Workers/D1/DO free tiers fail closed (errors, not charges). R2 is the one
  product that can bill overages — it stays out of v1.
- **Account hygiene:** keep the account on Workers Free. Upgrading to Workers
  Paid ($5/mo) would switch D1/DO/Workers to included-allowance + overage
  billing — do not upgrade without David's explicit approval.
- **Build-time actions:** (a) implement the auth fallback, not Access;
  (b) add the per-agent rate limits already required for v1 — they double as
  quota protection against retry-loop bugs, which are the only realistic way
  to burn a daily cap; (c) dashboard shows usage vs caps (already planned).
