# Codebase Path Map

Use this map to find the owning module before searching the entire repository.

## Runtime flow

```mermaid
flowchart LR
    Shell["App shell\napp + client-app-root"] --> Session["Encrypted session\ncloud-portfolio-app"]
    Session --> Dashboard["Dashboard coordinator\ncomponents/dashboard.tsx"]
    Dashboard --> Views["Feature views\ncomponents/dashboard/*"]
    Dashboard --> Domain["Accounting engine\npackages/domain"]
    Session --> Sync["Encrypted sync\nlib/portfolio-* + firebase-client"]
    Sync --> Firestore[("Firestore\nciphertext only")]
    Dashboard --> MarketClient["Market client\nlib/market-client.ts"]
    MarketClient --> Router["Worker router\nlib/server/market-router.ts"]
    Router --> Hub["Market object\nlib/server/market-hub.ts"]
    Hub --> Providers["Yahoo / Yahoo Japan / Japannext"]
```

## Where to make a change

| Change | Start here | Related code |
|---|---|---|
| Cost basis, holdings, splits, dividends | [`packages/domain/src/index.ts`](../packages/domain/src/index.ts) | [`packages/domain/src/index.test.ts`](../packages/domain/src/index.test.ts) |
| Shared quote types | [`apps/web/lib/server-market-types.ts`](../apps/web/lib/server-market-types.ts) | `packages/domain` `MarketQuote`, `IntradayBar` |
| Dashboard state or cross-view behavior | [`apps/web/components/dashboard.tsx`](../apps/web/components/dashboard.tsx) | `apps/web/components/dashboard/types.ts`, `helpers.ts`, `constants.ts` |
| One dashboard screen | [`apps/web/components/dashboard/`](../apps/web/components/dashboard) | nearest `*-view.tsx` and Playwright spec |
| Watchlist/search UI | [`apps/web/components/watchlist-view.tsx`](../apps/web/components/watchlist-view.tsx) | `use-security-search.ts`, `security-search-field.tsx`, `watchlist-search-overlay.tsx` |
| Chart rendering | [`apps/web/components/lightweight-charts.tsx`](../apps/web/components/lightweight-charts.tsx) | `lib/chart-geometry.ts`, `lib/chart-presentation.ts`, dashboard `charts.tsx` |
| Vault encryption and keys | [`apps/web/lib/vault-crypto.ts`](../apps/web/lib/vault-crypto.ts) | `vault-kdf.ts`, `argon2-key.ts`, `trusted-device-key-store.ts` |
| Encrypted sync and replay | [`apps/web/lib/portfolio-session.ts`](../apps/web/lib/portfolio-session.ts) | `portfolio-cloud-store.ts`, `portfolio-offline-queue.ts`, `*-event-merge.ts` |
| Client market loading/cache | [`apps/web/lib/market-client.ts`](../apps/web/lib/market-client.ts) | `client-market-cache.ts`, `market-snapshot-merge.ts`, `intraday-cache.ts` |
| Market backend (snapshot, catalog, PTS, history) | [`apps/web/lib/server/market-hub.ts`](../apps/web/lib/server/market-hub.ts) | [`docs/market-backend.md`](market-backend.md), `market-object.ts` (Durable Object), `market-router.ts` (Worker routing), `worker-entry.ts` |
| Provider parsing | [`apps/web/lib/server/market-sources.ts`](../apps/web/lib/server/market-sources.ts) | `yahoo-market.ts`, `yahoo-japan-fund.ts`, `monex-foreign-fund.ts`, `japannext-pts.ts` |
| Local/dev market route | [`apps/web/app/api/market/[resource]/route.ts`](../apps/web/app/api/market/[resource]/route.ts) | in-memory `MarketHub`; Cloudflare uses the Worker router instead |
| Build/versioning | [`scripts/build-release.mjs`](../scripts/build-release.mjs) | `scripts/source-build-id.mjs`, `next.config.mjs`, `app/api/version/route.ts` |
| Privacy enforcement | [`scripts/verify-private-data-boundary.mjs`](../scripts/verify-private-data-boundary.mjs) | `check-client-boundary.mjs`, Firestore rules, threat model |

## Dependency boundaries

```text
components ────────> client-safe lib ────────> packages/domain
     └─X─> server-*          │
                             └─X─> Cloudflare bindings

worker router ────> lib/server/market-* (Durable Object) ────> upstream providers
```

- `packages/domain` is pure and depends only on `decimal.js`.
- Client components import direct client-safe leaf modules.
- Market route handlers import server leaf modules. The `lib/server/` barrel is for navigation and server-only use.
- Firestore receives encrypted vaults and encrypted events. The market object stores public market data and a catalog of at most 200 public symbols.

## Dashboard feature hierarchy

```text
components/
├── dashboard.tsx                 # coordinator: state, effects, navigation, data orchestration
└── dashboard/
    ├── types.ts                  # shared props and view models
    ├── constants.ts              # shared labels, ranges, and keys
    ├── helpers.ts                # shared pure presentation helpers
    ├── charts.tsx                # feature chart composition
    ├── overview-view.tsx
    ├── holdings-table.tsx
    ├── security-detail-view.tsx
    ├── activity-view.tsx
    ├── dividends-view.tsx
    ├── notifications-view.tsx
    ├── settings-view.tsx
    ├── trade-modal.tsx
    ├── delete-transaction-dialog.tsx
    └── remove-account-dialog.tsx
```

Keep shared dashboard object shapes in `types.ts`. Keep leaf-only props beside the leaf component.

## Test routing

| Area | Fastest useful check |
|---|---|
| Domain math | `pnpm test:domain` |
| One library module | `pnpm test <matching-test-file>` |
| Market server/provider code | `pnpm test:market`, then `pnpm test:worker` |
| Real providers still parse | `pnpm check:live` |
| Search UI | `pnpm test:e2e:search` |
| Holdings grid UI | `pnpm exec playwright test apps/web/e2e/holdings-grid.spec.ts` |
| Firestore security rules | `pnpm test:rules` |
| Client/edge privacy | `pnpm verify:privacy` |
| All types and unit tests | `pnpm check` |
| Full browser matrix | `pnpm exec playwright test` |
