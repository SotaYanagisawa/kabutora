# Market-data scaling envelope

The production path is designed for a private portfolio of up to 200 tracked securities while remaining within Cloudflare Workers Free limits.

## Request budget

- Quotes are split into batches of 16. This caps a 200-security refresh at 13 authenticated Worker requests.
- A batch can use at most the primary chart host, secondary chart host, and the Japanese HTML fallback: 16 × 3 = 48 external subrequests, below the Free-plan limit of 50.
- Automatic refresh has a hard minimum of 10 minutes while a market session is active.
- Closed securities are refreshed at most every six hours.
- Hidden/background tabs do not refresh.
- Fresh client-cached active quotes younger than nine minutes and closed quotes younger than six hours are not requested again when the app reopens.

At 13 batches and roughly 100 active ten-minute cycles across the combined JP/US trading windows, the expected upper bound is about 1,300 Worker requests per day for one continuously open client, well below 100,000 requests/day. Multiple open clients still benefit from the canonical per-symbol edge cache.

## Storage and payload budget

- The server never stores portfolio membership or transaction data.
- IndexedDB stores complete quote fields, long-term normalized daily history, corporate actions, and seven days of 15-minute bars.
- The first intraday request loads five days. Later refreshes request one day and merge by security + timestamp.
- Duplicate intraday rows are replaced; rows older than seven days are compacted.
- Persistent browser storage is requested where the browser supports it; restricted/private iOS contexts remain a best-effort cache.
- Daily history revalidates over the network every six hours, while checksum and structural validation remain local every 15 minutes.

## Failure behavior

- Requests share a per-symbol memory/edge cache and in-flight promise.
- Provider failures try each Yahoo chart host once, then immediately use the last valid stale cache instead of multiplying retries.
- The edge cache keeps daily history for 180 days and quote/intraday responses for seven days as a stale fallback.
- A 14-day internal daily-history hole triggers a forced backfill.

## Free-tier boundary

This design minimizes usage but cannot promise unlimited free scaling. If the app grows from one private user to many continuously active users, the Cloudflare 100,000-request daily limit and the unofficial upstream provider become hard constraints. At that point, move quote coordination to a SQLite Durable Object or a licensed market-data feed and set an explicit spend cap.
