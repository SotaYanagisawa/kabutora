# Market API Guide

These routes expose public market data through the Cloudflare edge boundary.

- Authenticate every non-health request with the shared server-auth helpers.
- Accept only normalized public security descriptors or identifiers. Never accept portfolio records, quantities, balances, brokers, account IDs, transaction IDs, emails, or user display data.
- Keep route handlers thin: validate input, call a server service, and return a stable response with appropriate cache headers.
- Use D1/queue bindings through `cloudflare-market-env.ts`; do not import these routes or server modules from client components.
- Preserve ETag and snapshot-first behavior. Manual refresh enqueues work and must not block on history backfill.
- Bound upstream calls with timeouts and return partial coverage/failure metadata rather than discarding successful results.

Run the affected route/service tests, `pnpm verify:privacy`, and the root full gate before completion.
