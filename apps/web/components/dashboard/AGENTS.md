# Dashboard Guide

The dashboard is one coordinator component composed from feature hooks, plus memoized views.

## Structure

| File | Owns |
|---|---|
| `dashboard.tsx` | Composition and layout only: calls the hooks below, ledger inputs (transactions, accounts, securities), header/nav/views JSX |
| `use-dashboard-preferences.ts` | Every user preference: initial resolution (a newer edit on this device outranks an older cloud copy and is re-sent), browser persistence, per-field cloud reconciliation, upstream change reporting |
| `use-view-navigation.ts` | Active view (the last menu page is restored per device), retained views warmed after startup, scroll restoration, security detail page and its return target |
| `use-market-state.ts` | Market data state, browser market cache hydration/persistence, trusted market clock |
| `use-market-loaders.ts` | Network loading: quotes/benchmarks/history/distributions, PTS/US intraday polling, auto and manual refresh |
| `market-requirements.ts` | Pure: which security IDs need quotes/history/distributions, and ID-variant expansion |
| `use-portfolio-view-model.ts` | FX, display-currency conversion, per-filter summaries, holdings, dividends, notifications, chart series |
| `use-portfolio-history.ts` | Domain-worker history/summary calculation with per-filter caching and idle pre-warming |
| `use-touch-gestures.ts` | Swipe navigation, pull-to-refresh (touch and wheel), keyboard-aware viewport sizing |
| `use-trade-editor.ts` | Trade modal state and submit, transaction deletion, account removal |
| `types.ts` / `constants.ts` / `helpers.ts` | Shared view models / labels, keys and ranges / pure formatting helpers |
| `*-view.tsx`, `charts.tsx`, `holdings-table.tsx` | Page rendering and local interaction state |
| `trade-modal.tsx`, `*-dialog.tsx`, `updating-banner.tsx`, `retained-view.tsx` | Overlays and shell pieces |

## Rules

- Add cross-view data to `types.ts`; do not duplicate object shapes or introduce `any` props.
- Keep financial arithmetic in `@kabutora/domain` or Decimal-based library helpers. Components may convert finished values to numbers for rendering only.
- Views are memoized (`Fast*View`). Pass stable objects and callbacks, and do not pass props a view does not read: every changing prop re-renders the view.
- Values written to the DOM on every frame (pull distance, preload flags) use refs, not state, so they never re-render the dashboard.
- Preserve retained-view behavior and navigation state.
- A UI change is incomplete until both mobile WebKit and Chromium flows still work.

Use the root full gate for completion. During iteration, run the affected unit test or Playwright spec and `pnpm tc`.
