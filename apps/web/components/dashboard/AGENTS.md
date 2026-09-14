# Dashboard Guide

The dashboard is a feature package with one coordinator and focused views.

## Structure

- `../dashboard.tsx`: owns shared state, effects, market orchestration, navigation, and modal coordination.
- `types.ts`: canonical dashboard props and view models.
- `helpers.ts`: shared pure formatting and UI-domain helpers.
- `constants.ts`: shared labels, ranges, storage keys, and navigation definitions.
- `*-view.tsx`: page-level rendering and local interaction state.
- `charts.tsx`: dashboard-specific chart composition.
- `*-dialog.tsx` and `trade-modal.tsx`: focused overlays.

## Rules

- Add cross-view data to `types.ts`; do not duplicate object shapes or introduce `any` props.
- Keep financial arithmetic in `@kabutora/domain` or Decimal-based library helpers. Components may convert finished values to numbers for rendering only.
- Avoid moving shared effects from `dashboard.tsx` into leaf views unless ownership and cleanup become strictly clearer.
- Memoized views must receive stable objects and callbacks where practical. Preserve retained-view behavior and navigation state.
- A UI extraction is incomplete until both mobile WebKit and Chromium flows still work.

Use the root full gate for completion. During iteration, run the affected unit test or Playwright spec and `pnpm tc`.
