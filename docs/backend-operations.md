# Backend operations

Operate the existing `kabutora` Worker, `kabutora-market` D1 and Firebase project. Do not create replacement projects or export plaintext user records for troubleshooting.

## Observe

Approved members can call `GET /api/market/status` with Firebase ID and App Check headers. It returns aggregate jobs, provider reservations, D1/SQLite counters, last alarm/publication and deferred deadlines. No member IDs, financial records, search text or source bodies are included. Compare HTTP availability with manifest `published_at`; a working cache can contain delayed source data.

Use existing Cloudflare logs/metrics for CPU, duration, outcomes and account-wide costs. Publication logs contain resource kind, changed status and elapsed wall time only. Never paste tokens, raw traces, usable keys, vault contents or provider bodies into logs. Coordinator counters cover its work, not every account workload or cached API read.

Investigate no progress for 20 minutes during eligible sessions, pending work over one hour, source failures through five retries, or operating budgets above 80%. Closures, source delay and explicit budget deferral can explain stale data. Distinguish these from authentication, local storage and encrypted sync failures.

## Recover

| Symptom | Action |
|---|---|
| Stopped coordinator | Check the one-minute Cron and Durable Object binding; redeploy the current security-safe release if missing. Retain SQLite state and D1 generations. |
| Source/parser outage | Retain previous publication. Allow bounded retries/cooldowns. Repair against captured public fixtures, test, and deploy. Never bypass reservations or start independent collectors. |
| Daily allowance exhausted | Let jobs defer to the next UTC day. Check account-wide quotas, then reduce acquisition/backfill before changing caps. Do not enable billing automatically. |
| Auth failure | Check Firebase audience, App Check app ID, approved UIDs and token expiry; for sync also `appAccess/{uid}`. Keep auth enforced. |
| Corrupt/expired chunk | Retain valid client data. SHA-256 verification rejects corrupt cache bytes. Retry the current manifest when a generation expires; interrupted publication resumes without exposing incomplete chunks. |
| Pending encrypted edits | Keep the outbox. Use local diagnostics and retry after connectivity/storage recovery. Size rejection never authorizes event deletion or vault truncation. |
| Interrupted recovery enrollment | Resume the trusted device's verified preparation or use the owner's encrypted backup/credential. Retain the old cloud key until atomic activation. Never administratively delete keys to force migration. |

## Private-group membership

Collect the intended member's Firebase UID through an owner-controlled channel. Add only approved UIDs to the `KABUTORA_ALLOWED_UIDS` secret and separately create `appAccess/{uid}` as administrator. Preserve existing members. Revocation removes both authorizations; tokens alone do not override them. Member A cannot access member B's vault, events, keys, receipts or controls. Smoke-test real accounts without copying portfolios/keys into Cloudflare.

## Release and compatibility retirement

Run `pnpm check:full`, `pnpm test:cloud`, `pnpm test:worker:stress`, then `pnpm --filter @kabutora/web build:cloudflare`. Apply additive public migrations. Build with client backend `v2`, recovery `enabled` and release stage `complete`; deploy the existing Worker and compatible Firestore rules. Verify version/new assets, auth denial, authenticated manifests, refresh and ciphertext-only reconciliation.

The old Queue consumer transfers pending public jobs to the coordinator. V2 Cron/refresh produce no Queue messages. Check backlog metrics and old-client recovery before removing producer/consumer bindings; never delete a Queue instead of draining it. Retain old tables through the compatibility window and recovery drill.

Rollback switches client/server to `legacy` in a security-safe build, disables canary acquisition, and restores legacy schedules with one producer. Keep activated vaults compatible and raw-key writes denied. Do not reset Firestore, outboxes, generations or Durable Object storage.

## Acceptance record

Record seven days spanning JP/US sessions, closures and a provider-failure drill. Measure cached API p95/p99 and refresh acknowledgements from US/Japan, source freshness, billed rows, CPU/duration and peak devices. Record physical Safari/iOS and two approved real members separately from emulation. Synthetic stress and WebKit are supporting evidence, not substitutes.
