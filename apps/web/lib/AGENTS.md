# Web Library Guide

`apps/web/lib` is grouped by dependency domain. Import leaf modules directly; there are no barrels.

## Folders

| Folder | Runtime | Contents |
|---|---|---|
| `charts/` | client + edge | `chart-domain`, `chart-geometry`, `market-time` (exchange time zones and labels), `numeric-extent` |
| `market/` | client + edge | `market-client` (the only market transport), `market-wire` (wire format, validation; shared with edge), catalogs, sessions, labels, security ID normalization, search ranking |
| `portfolio/` | client | portfolio filters, ledger validation, trade-input parsing (accounting itself is in `@kabutora/domain`) |
| `sync/` | client | encrypted Firestore store, session, offline queue, event merges, preference save scheduler, Firebase client/config, IndexedDB |
| `vault/` | client | vault crypto, KDF + worker, Argon2 key, trusted-device and verified-vault stores |
| `ui/` | client | touch navigation, page visibility, operation deadlines, client recovery, updating status, display formatting (`compact-number`, `company-name`, `calendar-time`) |
| `server/` | **edge only** | `market-service` (catalog, snapshot, history records, refresh policy), `market-object` (Durable Object), `market-router`, `market-upstream` (Yahoo, Yahoo! ファイナンス funds, Monex, Japannext, TOPIX), `market-search`, `server-auth` |

## Rules

- Keep tests beside their leaf module as `<name>.test.ts`.
- Parse network, storage, and provider data as `unknown`; narrow with a validator before use.
- Keep utilities focused and dependency-light. If a helper is used by one feature only, keep it with that feature.
- Client code may import only types from `server/`. `scripts/check-client-boundary.mjs` (run by `pnpm verify:privacy`) rejects runtime imports.
- Keep server provider failures typed and stable at route boundaries; do not leak raw upstream payloads or secrets.
- Preserve encrypted payload formats and migration compatibility when changing sync or vault code.
- Use bounded caches and explicit invalidation/version keys for persistent browser data.

Run the matching test file during iteration. Use `pnpm verify:privacy` for changes that touch imports, sync, vaults, API payloads, or Firebase, then use the root full gate.
