# Dashboard Guide

The dashboard is one coordinator component composed from feature hooks, plus memoized views.

## Structure

| File | Owns |
|---|---|
| `dashboard.tsx` | Composition and layout only: calls the hooks below, ledger inputs (transactions, accounts, securities), header/nav/views JSX |
| `use-dashboard-preferences.ts` | Every user preference: initial resolution, browser persistence, per-field cloud reconciliation, upstream change reporting |
| `use-view-navigation.ts` | Active view, retained (idle-mounted) views, scroll restoration, security detail page and its return target |
| `use-market-data.ts` | Market snapshot polling, history loading (only when the server's history revision changes), localStorage cache for first-frame prices, server clock offset |
| `use-portfolio.ts` | The engine wiring: book, valuation per filter/currency, holdings, daily and intraday history, dividends, notifications, detail page, diagnostics |
| `use-touch-gestures.ts` | Swipe navigation, pull-to-refresh (touch and wheel), keyboard-aware viewport sizing |
| `use-trade-editor.ts` | Trade modal state and submit, transaction deletion, account removal |
| `types.ts` / `constants.ts` / `helpers.ts` | Shared view models / labels, keys and ranges / pure formatting helpers |
| `*-view.tsx`, `charts.tsx`, `holdings-table.tsx` | Page rendering and local interaction state |
| `trade-modal.tsx`, `*-dialog.tsx`, `updating-banner.tsx`, `retained-view.tsx` | Overlays and shell pieces |

## Rules

- Add cross-view data to `types.ts`; do not duplicate object shapes or introduce `any` props.
- Keep financial arithmetic in `@kabutora/domain` (through `use-portfolio.ts`). Views format engine output; they do not compute positions, splits or values.
- Views are memoized (`Fast*View`). Pass stable objects and callbacks, and do not pass props a view does not read: every changing prop re-renders the view.
- Values written to the DOM on every frame (pull distance, preload flags) use refs, not state, so they never re-render the dashboard.
- Preserve retained-view behavior and navigation state.
- A UI change is incomplete until both mobile WebKit and Chromium flows still work.

Use the root full gate for completion. During iteration, run the affected unit test or Playwright spec and `pnpm tc`.
