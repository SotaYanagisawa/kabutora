# Backend overhaul implementation and acceptance

The replacement backend is implemented and configured for production cutover: the Worker and client use `v2`, and verified recovery enrollment is enabled. Configuration alone does not prove deployment. The release record below distinguishes completed checks from outstanding acceptance evidence.

## Public market backend

- [`MarketCoordinator`](../apps/web/lib/server/market/coordinator.ts) uses one SQLite Durable Object for the private group. Resource admission prevents overlapping batches from repeating logical work. Durable leases, partial retries, provider cooldowns and a publication outbox survive restarts. After cutover, Cron wakes this coordinator and the old scheduler no longer produces jobs.
- [`ingestion.ts`](../apps/web/lib/server/market/ingestion.ts) separates quotes, history, distributions, benchmarks and PTS. [`provider-fetch.ts`](../apps/web/lib/server/market/provider-fetch.ts) bounds response bytes, concurrency and deadlines and reserves every attempt, including redirects/fallbacks. [`provider-policy.ts`](../apps/web/lib/server/market/provider-policy.ts) defines host allowlists, capabilities and individual source budgets in addition to the shared daily ceiling. There is no paid fallback.
- [`observations.ts`](../apps/web/lib/server/market/observations.ts) distinguishes observation timestamps from successful checks and prevents older prices replacing newer prices. History is stored by instrument/month with separate inception metadata. Exact decimal strings and existing domain calculations are retained.
- [`publisher.ts`](../apps/web/lib/server/market/publisher.ts) commits immutable chunks before advancing manifests. SHA-256 descriptors let browsers verify and reuse unchanged chunks. Authenticated reads use indexed storage and public edge caching, preserve ETags, serve cached manifests during storage failure, and never fetch providers. Cold missing resources return a bounded retry response.
- [`history-publication.ts`](../apps/web/lib/server/market/history-publication.ts) processes at most three instruments per invocation and freezes child revisions for each global generation. Interrupted work resumes; previous generations have a 15-minute storage grace period. [`intraday-publication.ts`](../apps/web/lib/server/market/intraday-publication.ts) reads bounded regular/PTS batches and preserves separate sessions without materializing the entire raw catalog.
- [`public-market-client.ts`](../apps/web/lib/public-market-client.ts) downloads common group manifests/chunks. Private symbol selections and transaction dates filter locally. History expands only the local selection; quotes and intraday load independently. Response bytes and download concurrency are bounded. [`public-chunk-cache.ts`](../apps/web/lib/public-chunk-cache.ts) uses separate public-only IndexedDB with 4 MB memory and 96 MB disk ceilings, falling back to memory when storage is unavailable. It never opens or clears a vault or event queue.
- [`storage-budget.ts`](../apps/web/lib/server/market/storage-budget.ts) meters actual D1 result counters; the coordinator meters actual SQLite cursor counters. Invocation-boundary checkpoints can lose at most one bounded invocation on a crash, so operating ceilings leave headroom. Exhaustion defers acquisition until the next UTC day. These controls do not guarantee provider uptime or cap account-wide billed usage on a paid plan.

Existing accounting features, settings, chart contracts and exports remain intact. Obsolete provider endpoints are authenticated and return an upgrade response after cutover, preventing quota bypass. Manual refresh shares one public run across members and distinguishes updated, partial, pending and deferred completion.

## Encryption and account isolation

The client no longer uploads usable raw keys or automatically replaces recovery protection. Firestore rules deny every new raw-key create/update. Existing legacy key reads remain until the owner enrolls recovery, verifies it locally and atomically activates a fresh generation. Installing this release does not retroactively encrypt old server key records; blindly deleting them risks data loss.

Backup enrollment retains the original cloud key until activation and reconciles concurrent encrypted edits. Receipt-backed compaction uses eight-event batches. Oversized cloud payloads fail before writing without truncating private data or clearing the outbox. Local diagnostics report aggregate pending bytes/age. Vault/event formats and private Firestore records are preserved; deployment performs no private-data migration.

Firebase ID tokens and App Check remain required. `KABUTORA_ALLOWED_UIDS` accepts multiple approved UIDs, with the existing singular secret as fallback. Firestore separately requires administrator-created `appAccess/{uid}` membership. No extra real identity is authorized without its UID. Real signed-token tests cover two synthetic members, expiry, missing App Check, outsiders and revocation; Firestore/browser suites cover isolation and reconciliation.

## Sources and cost

The [ECB reference feed](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml) supplies a daily USDJPY fallback without an account or key, labelled as an official close. Yahoo, Yahoo Japan, CNBC, Japannext, Monex and BlackRock retain their existing parsers behind bounded acquisition. Their group-use permission is explicitly unverified in the capability matrix. Free public access cannot establish permission or guarantee availability. No new paid source, billing upgrade or hosting project was introduced.

## Release and rollback

Schema changes are additive and target the existing `kabutora-market` public database. Migrations `0008`–`0010` were deployed with the compatible release. `0011_market_chunk_descriptors.sql` was rehearsed in the actual local Worker and applied remotely on 2026-10-02. The pre-overhaul public export remains outside the repository at `/private/tmp/kabutora-market-before-overhaul.sql` (75,376,587 bytes). No decrypted portfolio export was used.

The canary uses `legacy` plus `KABUTORA_MARKET_CANARY=true`. Its acquisition guard prevents a second collector while it publishes existing public data. Cutover deploys client/Worker `v2` together and replaces the two old schedules with one minute Cron. The transition Queue consumer remains to drain old messages into the coordinator and support the compatibility window; v2 produces no new Queue messages. Remove bindings only after backlog and old-client recovery evidence, without deleting pending work.

Rollback restores a security-safe client/Worker with both backend flags at `legacy`. Stop v2 acquisition before restarting the old producer. Keep additive public tables and the Durable Object namespace. Never downgrade an activated vault, clear device queues or overwrite newer encrypted events. See the [operations runbook](backend-operations.md).

## Evidence and remaining acceptance

The real SQLite history fixture exercises 200 instruments, 30 years and 1,512,000 points, including restart, failed publication, correction and previous-generation reads. Invocations stay within 45 D1 queries and materialize one instrument's month rows at a time. The browser fixture traverses 1,512,000 common points while expanding 7,560 selected points without sending the selection.

`pnpm test:worker:stress` passed 12 actual local Worker checks: 200 instruments, 400,000 regular points and 1,500 PTS frames produced 102,400 public points in 17 chunks, without provider calls. Focused tests passed for conditional caching, refresh bypass, stale reads during storage failure, wrong SHA-256 descriptors and oversized multibyte responses. `pnpm test:cloud` previously passed 32 tests with the replacement client; final gate results are recorded below after completion.

A seven-day production soak, physical Safari/iOS, real additional-member smoke tests and latency measurements from both US and Japan need separate evidence. These are acceptance requirements that cannot be completed by flipping flags. The [original plan](backend-overhaul-plan.md) records the targets. Do not claim a 99.9% SLA or guaranteed zero cost from synthetic tests or anonymous HTTP 200.

## Deployment record

- Compatible release: build `kabutora-dc569defe1e37b9e7b40`, Worker `3f9886a9-190b-4b2d-b091-275f1373e872`.
- Public-data canary: Worker `04a14275-7f97-4c37-8af3-da12926d86f0`, 2026-10-02. Cloudflare build, built privacy check, remote additive migration and existing-Worker deploy succeeded. Remote D1 and sanitized production traces confirmed quote, intraday, history and distribution publication. Recorded successful publication invocations reported CPU/wall times of 332/7,024 ms (quotes), 29/2,814 ms (history completion) and 246/4,798 ms (distributions); these are individual samples, not latency percentiles or maximum-catalog deployed benchmarks.

## Final local gate

`pnpm check:full` exited 0 on 2026-10-02: type checking; 82 unit files / 477 tests; 290 Firestore authorization, generation, lock, privacy and compaction checks; privacy result `private_data_absent` (83 probes, 95 client modules); nine actual local Worker checks; 104 Chromium/WebKit desktop/mobile browser tests passed with four intentional skips. `pnpm test:worker:stress` independently passed the maximum-catalog fixture described above. `pnpm verify:privacy` passed against the built canary. The encrypted cloud suite is rerunning on the final source before release.

Remote canary coverage was 55 canonical registered instruments / 55 quoted, with 55 instrument history parts in 62 chunks. All five public manifests existed and no chunk-descriptor counts mismatched. These are coverage/parity checks against retained data, not evidence of current feed availability. `firebase deploy --only firestore:rules --project kabutora-20260810-7a4e` exited 0 and released the deny-new-raw-key rules.

Documentation link validation passed. Whole-tree `git diff --check` continues to report the preserved pre-existing blank line at EOF in `server-market-response-cache.test.ts`. No unrelated work was reset or committed.

Read-only cost checks returned Firebase `billingEnabled=false` for the existing project. Cloudflare account/Worker metadata returned usage model `standard`, but the subscription endpoint returned HTTP 403 to the existing OAuth token; that metadata does not independently establish the account's subscription price. No billing settings were changed. Production cost verification remains an owner-visible account check, and acquisition ceilings remain enforced. See [Firebase plan semantics](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) and [Cloudflare account metadata](https://developers.cloudflare.com/api/resources/workers/subresources/account_settings/methods/get/).

`pnpm test:cloud` exited 0 on the final v2 source: all 32 encrypted-cloud browser tests passed in 5.7 minutes, including first-device recovery, trusted unlock, shared-device storage denial, verified migration, offline two-device reconciliation and legacy encrypted backup restoration across desktop/mobile Chromium/WebKit.

## Production v2 cutover, 2026-10-02

The final release is live at [Kabutora](https://kabutora.kabutora-7a4e.workers.dev): build `kabutora-ae6c7a3d4cf2de649f90`, Worker version `46264d33-aa35-478c-994f-21e9b17488f6`. Server/client backend is `v2`, canary is off, verified recovery enrollment is enabled and only the one-minute coordinator watchdog remains. Existing secrets, account membership, encrypted data and Queue backlog were preserved.

Commands and outcomes:

- `NEXT_PUBLIC_KABUTORA_MARKET_BACKEND=v2 NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION=enabled KABUTORA_RELEASE_STAGE=complete pnpm --filter @kabutora/web build:cloudflare`: exit 0. The deterministic release digest matched source immediately before deploy.
- `pnpm verify:privacy` after the final build: exit 0, `private_data_absent`, 83 probes / 95 client modules.
- From `apps/web`, `node node_modules/@opennextjs/cloudflare/dist/cli/index.js deploy`: exit 0, existing `kabutora` Worker and trigger updated.
- `node /private/tmp/kabutora-verify-production.mjs`: exit 0, origin HTTP 200, CSP present, exact release build ID and three changed frontend assets all HTTP 200. Snapshot, history and public-resource requests without authentication returned 401 with no-store. Additional status/progress/invalid-query probes also returned 401 before cached reads.
- Production browser observation reached the normal Google sign-in screen. No authenticated real-member session was available; no new UID was invented or authorized.
- Remote public D1 inspection confirmed live v2 acquisition (31 observations checked through 14:30:05 UTC) and advancing quote/intraday/history manifests. Existing cached coverage was retained.

One initial post-cutover scheduled trace reported an exception. The coordinator recovered without a rollback or private-data operation. The subsequent diagnostic sample contained 53 successful scheduled invocation traces, no reported exceptions, and quote/PTS/benchmark/history publication. Maximum reported CPU in that sample was 502 ms; no p95/p99 or long-term availability claim follows from this short sample. Some bounded dependency/publication retries were observed and retained valid data. The initial exception's specific cause was not captured; keep it in the soak investigation rather than asserting it was fixed.

The seven-day soak, physical Safari/iOS, real additional-member tests, regional authenticated latency measurements, Cloudflare subscription verification and compatibility Queue retirement remain acceptance work. Existing legacy vault owners must complete locally verified recovery enrollment to retire historical server key records. The code and production cutover are delivered; these external or elapsed-time requirements are not claimed complete. This deployment record was added after release and does not change the deployed application code.
