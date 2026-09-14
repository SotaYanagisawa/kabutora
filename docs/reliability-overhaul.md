# Reliability overhaul — implementation record

The approved scope is the full startup, chart, calculation, synchronization,
recovery-key, quality-gate and production delivery plan in the current Codex task.
No existing product capabilities may be removed. Google-only key custody is being
replaced by the explicitly approved one-time recovery enrollment.

Baseline source archive: `/private/tmp/kabutora-overhaul-baseline-xjWmjO/source.tar.gz`.
Its manifest records the source digest and Git revision. The working tree already
contained extensive changes before this implementation; preserve all of them.

## Audit baseline

- 304 unit tests, 28 browser tests, TypeScript, Firestore rule tests and Cloudflare
  build passed. The old browser harness allowed unexpected HTTP 500 responses.
- Chart touch selection followed by JP → shorter US history reproducibly entered
  the application error boundary in Chromium and WebKit.
- 24 changes with 1,000 transactions / 37,800 bars accumulated 15 pending WebKit
  jobs and copied 936,000 history rows.
- Authenticated physical Mac/iOS Safari startup and tab process termination still
  require real-device verification; passing simulated WebKit is not equivalent.

## Implementation checklist

- [x] Chart selection and local error recovery, including all chart variants.
- [x] Bounded, cancellable history worker with shared indexed datasets and yielding fallback.
- [x] Startup state machine, deadlines, retry and verified cached view.
- [x] Decimal calculations, missing FX handling and input validation.
- [x] Memory/persistent queue, retries and cross-device compaction.
- [x] Versioned recovery enrollment and coordinated migration with legacy queue recovery.
- [x] Strict browser/emulator tests and comprehensive regression cases.
- [ ] Deterministic source-based release ID, all checks, Cloudflare deployment and live verification.

Record actual test outcomes here as validation completes. Do not interpret this
checklist as permission to leave approved work unfinished.

## Verification in progress

- Full unit/type check: 339 tests in 59 files passed after the startup/cache,
  queue-storage retry, trade-draft, password-worker, and independent preference
  reconciliation changes. Privacy scanning found no plaintext portfolio records
  or usable vault keys in the built artifact.
- Expanded browser run: 66 passed and 2 intentional desktop-only layout cases
  skipped across desktop/mobile Chromium and WebKit. The 24-case isolated cloud
  suite completed 23 cases in the final full pass; the final mobile Chromium
  cross-device case then passed in its focused rerun after the test began waiting
  for the deliberately debounced preference write. Desktop and mobile WebKit
  cross-device reruns passed after reopen/replay verification.
- The 100-change fixture copied no history on filter changes and retained at
  most two jobs. Recorded p95: desktop Chromium 59.7 ms, desktop WebKit 38 ms.
  Both also passed the 5,000-transaction / 109,800-bar fixture and the expanded
  JP → shorter US → empty chart/currency/date-range regression.
- Firebase's production authorized-domain list includes
  `kabutora.kabutora-7a4e.workers.dev`; verified with the configured CLI account.
  Same-origin redirect proxy routes were previously verified to return 200.
- Production is still the pre-overhaul release
  `d3a297be-6df3-469f-a2a0-bf39992e9aaf`. No new application or rules deployment
  has occurred. Do not roll back an activated v2 vault to a v1-only client.
- Actual Safari automation is unavailable while its "Allow remote automation"
  setting is disabled. Permission to enable it temporarily has been requested.
- Physical Mac/iOS Safari, real Google sign-in and production authenticated
  startup remain open verification items. The prepared repair release is
  `kabutora-e8465f8706d82ed80065`; its recorded source digest is
  `e8465f8706d82ed800656be2c41c09bec767d0d62ac3df6d0da34a8ba90fdaf6`.
