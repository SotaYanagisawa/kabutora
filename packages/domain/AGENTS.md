# Portfolio Engine Guide

`packages/domain` is a pure TypeScript package with no dependencies. It must have no browser, React, Next.js, Cloudflare, Firebase, filesystem, or network dependency.

| Module | Owns |
|---|---|
| `portfolio.ts` | `buildBook` (trades in today's share units), `valuePortfolio`, `portfolioHistory`, `intradayHistory`, `securityHistory`, `dividendReceipts`, `tradeRows`, currency conversion |
| `market.ts` | Market data types shared with the backend (`Quote`, `DailyHistory`, `Split`, `Dividend`), `marketKey`, split factors |
| `notifications.ts` | Split, price-move and TSE limit notices derived from the book and market data |
| `dates.ts` | Exchange-time-zone dates and sorted-array lookups |

- Splits: `splitFactorAfter(splits, tradeDate)` converts each trade once. Never apply a split as a timeline event and never combine split lists from several sources.
- Cost basis: moving average (移動平均法) per security and cost-basis group; sales clamp to the units held and are reported in `book.issues`.
- Money: float64, rounded only for display. USD/JPY on the trade date for cost, on the valuation date for value, on the recognition date for dividends.
- Keep calculations deterministic and side-effect free; order trades by date, original timestamp, creation time and id.
- Market data is looked up by `marketKey(securityId)`; ledger ids are never rewritten.
- Cover splits/reverse splits, partial sales, cost-basis groups, funds quoted per 10,000 units, currencies, missing quotes and dividends when relevant.

Run `pnpm test:domain` while iterating. Use the root full gate before completion.
