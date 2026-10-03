# Web App Guide

This guide applies to `apps/web`. The root invariants remain in force.

## Boundaries and routing

- `app/`: Next.js layouts, pages, and route handlers.
- `components/`: client UI grouped by feature (`app/`, `dashboard/`, `watchlist/`, `search/`, `charts/`). Keep orchestration in hooks at the feature root and focused rendering in views.
- `lib/`: framework-light modules grouped by domain (`charts/`, `market/`, `portfolio/`, `sync/`, `vault/`, `ui/`). Edge-only code lives in `lib/server/` and must stay out of client dependency graphs.
- `app/globals.css`: the single global stylesheet, in cascade order. Find styles by searching for `SECTION: <name>`; keep new rules in the matching section and add mobile overrides to `SECTION: responsive`. Keep it one file: splitting it with `@import` or multiple imports lets the bundler reorder rules.
- `e2e/` and `cloud-e2e/`: local UI coverage and encrypted multi-device coverage.

Prefer `@/` imports across web areas and relative imports within one feature directory. Import leaf modules directly; do not add barrel `index.ts` files, which can hide an edge dependency in a client bundle.

## Change rules

- Preserve App Router and Cloudflare Workers compatibility; avoid Node-only APIs in edge paths.
- Keep client startup resilient to unavailable storage, stale caches, offline state, and release skew.
- Update service-worker caches and build/version behavior together when asset loading changes.
- Put shared view models at the feature boundary. Do not use `any` in production code; validate external data as `unknown` before narrowing.
- Keep accessibility labels, touch behavior, reduced-motion behavior, and desktop/mobile layouts intact.

## Verification

During iteration, run the closest unit test plus `pnpm tc`. Before completion, use the root full gate. For a user-visible change, also run the Cloudflare build and follow the root delivery rules.
