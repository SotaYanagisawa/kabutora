# Web Library Guide

`apps/web/lib` contains several dependency domains in one directory. The subdirectory `index.ts` files are navigation barrels; production code should import the direct leaf module.

## Module groups

| Group | Leaf modules |
|---|---|
| Accounting adapters | `domain-worker*`, `portfolio-history-calculation`, `portfolio-calculation-inputs`, validation and Decimal helpers |
| Charts | `chart-domain`, `chart-geometry`, `chart-presentation` |
| Market client | `market-client` (the only market transport), `client-market-cache`, session/clock, catalogs, search, snapshot merge |
| Encrypted sync | `portfolio-*`, event merge modules, Firebase client/config, recovery and status modules |
| Vault | `vault-*`, `argon2-key`, trusted-device and verified-vault stores |
| Edge market services | `server/market-*` (hub, Durable Object, router, sources, search), `server-auth`, `server-market-types`, fund/PTS/Yahoo adapters |
| UI utilities | touch navigation, page visibility, operation deadlines |

## Rules

- Keep tests beside their leaf module as `<name>.test.ts`.
- Parse network, storage, and provider data as `unknown`; narrow with a validator before use.
- Keep utilities focused and dependency-light. If a helper is used by one feature only, keep it with that feature.
- Do not import from `server/index.ts` in client code. The privacy check traverses client imports and rejects server paths.
- Keep server provider failures typed and stable at route boundaries; do not leak raw upstream payloads or secrets.
- Preserve encrypted payload formats and migration compatibility when changing sync or vault code.
- Use bounded caches and explicit invalidation/version keys for persistent browser data.

Run the matching test file during iteration. Use `pnpm verify:privacy` for changes that touch imports, sync, vaults, API payloads, D1, or Firebase, then use the root full gate.
