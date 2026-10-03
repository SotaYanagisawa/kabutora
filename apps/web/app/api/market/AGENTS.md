# Market API Guide

On Cloudflare, `/api/market/*` is routed by [`lib/server/market-router.ts`](../../../lib/server/market-router.ts) before Next.js and served by the `MarketCoordinator` Durable Object. The single route in `[resource]/route.ts` serves the same `MarketHub` in memory for the local Mac app and `next dev`. See [`docs/market-backend.md`](../../../../../docs/market-backend.md).

- Authenticate every request except `health` with `authorizeMarketRequest`.
- Cloud reads (`snapshot`, `history`, `distributions`) take no symbol lists: the response covers the shared public catalog and the browser filters locally. `history` accepts only a year start.
- `registry` accepts a body with exactly `securityIds`. Cloud clients send one explicit search selection per call (the object enforces this); the catalog is capped at 200.
- Never accept portfolio records, quantities, balances, brokers, account or transaction IDs, emails or user display data.
- Requests never wait on slow page scrapes or history backfill. Upstream work stays within 50 subrequests per invocation and keeps the last good data on failure.

Run `pnpm test:market`, `pnpm test:worker`, `pnpm verify:privacy`, and the root full gate before completion.
