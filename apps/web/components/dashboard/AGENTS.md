# Dashboard Component Guide

The dashboard is one coordinator component composed from feature hooks, plus memoized view modules (`apps/web/components/dashboard/*-view.tsx`).

| File | Owns |
|---|---|
| `dashboard.tsx` | Composition and layout only: calls the hooks below, ledger inputs (transactions, accounts, securities), header/nav/views JSX |
| `use-dashboard-preferences.ts` | Every user preference: initial resolution (a newer edit on this device outranks an older cloud copy and is re-sent), browser persistence, per-field cloud reconciliation, upstream change reporting |
| `use-view-navigation.ts` | Active view (the last menu page is restored per device), retained (idle-mounted) views warmed after startup, scroll restoration, security detail page and its return target |
| `use-market-data.ts` | Market snapshot polling, history loading (only when the server's history revision changes), localStorage cache for first-frame prices, server clock offset |
| `use-portfolio.ts` | The engine wiring: book, valuation per filter/currency, holdings, daily and intraday history, dividends, notifications, detail page, diagnostics |
| `use-touch-gestures.ts` | Swipe navigation, pull-to-refresh (touch and wheel), keyboard-aware viewport sizing |
| `use-trade-editor.ts` | Trade modal state and submit, transaction deletion, account removal |
| `use-modal-focus.ts` | Dialog behavior: Escape closes the top dialog, Tab stays inside, focus returns to the opener |
| `use-incremental-list.ts` | `useMediaQuery`, and paged rendering for long lists (the ledger renders one layout, 120 rows at a time) |
| `types.ts` / `constants.ts` / `helpers.ts` | Shared view models / labels, keys and ranges / pure formatting helpers |

## Invariants

- Keep UI components decoupled from remote providers. Components read only the normalized types in `types.ts` through `usePortfolio` and `useMarketData`.
- Touch gesture code belongs in `use-touch-gestures.ts`; layout adjustments belong in CSS / Tailwind classes.
- Modals, popovers, and slide-overs must trap focus, close on Escape, and restore focus to the trigger element on close.
- When adding or changing dashboard UI, verify that both touch swipe navigation and mouse wheel gestures still function on mobile and desktop viewports.
