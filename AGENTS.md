# Kabutora Agent Guide

## Start here

1. Inspect `git status` before editing. Preserve all unrelated and uncommitted work.
2. Read [`docs/path-and-nodes.md`](docs/path-and-nodes.md) for the current module map.
3. Before changing a specialized area, read its nearest scoped `AGENTS.md`:
   - [`apps/web/AGENTS.md`](apps/web/AGENTS.md)
   - [`apps/web/components/dashboard/AGENTS.md`](apps/web/components/dashboard/AGENTS.md)
   - [`apps/web/lib/AGENTS.md`](apps/web/lib/AGENTS.md)
   - [`apps/web/app/api/market/AGENTS.md`](apps/web/app/api/market/AGENTS.md)
   - [`packages/domain/AGENTS.md`](packages/domain/AGENTS.md)
4. Use targeted tests while iterating. Run the complete gate once after the final code change.

## Non-negotiable invariants

- Preserve existing features, UI controls, settings, data formats, and public exports unless the user explicitly asks to change them.
- Plaintext portfolio data—symbols tied to a user, shares, prices, amounts, balances, accounts, and transactions—must never reach Cloudflare or unencrypted Firestore. Only encrypted vault or event payloads may cross the sync boundary.
- Use `Decimal` from `@kabutora/domain` for financial calculations. Native number conversion is allowed only at display and chart boundaries.
- React client code must never import edge modules (`apps/web/lib/server-*` or `apps/web/lib/server/`).
- Market requests from cloud clients carry no user symbol lists. Everyone reads the shared catalog snapshot and filters locally; see [`docs/market-backend.md`](docs/market-backend.md).
- Keep the build ID deterministic across all Next.js build processes. Use the shared build-ID source; never add independent runtime timestamps to `next.config.mjs`.

## Repository map

| Area | Purpose |
|---|---|
| `packages/domain` | Pure accounting and portfolio-history engine |
| `apps/web/app` | Next.js routes and application shell |
| `apps/web/components` | Client UI and orchestration |
| `apps/web/lib` | Client services, sync, crypto, market adapters, and edge services |
| `firebase` | Encrypted portfolio access rules |
| `scripts` | Builds, packaging, and boundary verification |

The `apps/web/lib/{charts,domain,market,server,sync,ui,vault}/index.ts` files are navigation barrels. Prefer direct leaf-module imports in production code so client/edge boundaries stay visible and bundlers do not pull broad graphs.

## Verification

- Focused unit test: `pnpm test <test-file>`
- Fast unit suite: `pnpm test:fast`
- Full type and unit gate (includes market performance contracts): `pnpm check`
- Real Worker + Durable Object market backend with latency and request budgets: `pnpm test:worker`
- Privacy and client/edge boundary: `pnpm verify:privacy`
- Chromium + WebKit, desktop + mobile: `pnpm exec playwright test`
- Live upstream providers (network): `pnpm check:live`
- Cloudflare build: `pnpm --filter @kabutora/web build:cloudflare`
- Deployed site, auth and market freshness: `pnpm verify:prod`
- Complete local gate: `pnpm check:full`

For code changes, run `pnpm check:full` once after the final edit. It includes `pnpm check`, `pnpm test:worker`, `pnpm verify:privacy`, the complete Playwright matrix and Firestore rules. `pnpm check` already includes type checking; do not rerun `pnpm tc` unless diagnosing a type-only failure. When market providers change, also run `pnpm check:live`. After a deploy, run `pnpm verify:prod`. Documentation-only changes require link/path validation rather than the runtime gate.

## Delivery

For user-visible website changes, build with the existing Cloudflare/OpenNext configuration, deploy to the existing `kabutora` Worker, then verify the production origin returns HTTP 200 and references the new frontend assets. Do not create another hosting project.

Report exact commands and outcomes. Never claim a check, deployment, or live verification that did not run successfully.
