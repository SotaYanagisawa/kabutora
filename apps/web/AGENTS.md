# Web App Guide

This guide applies to `apps/web`. The root invariants remain in force.

## Boundaries and routing

- `app/`: Next.js layouts, pages, and route handlers.
- `components/`: client UI. Keep orchestration at feature roots and move focused rendering into feature directories.
- `lib/`: framework-light services and utilities. Keep server-only modules out of client dependency graphs.
- `migrations/`: D1 tables for public market data only.
- `e2e/` and `cloud-e2e/`: local UI coverage and encrypted multi-device coverage.

Prefer `@/` imports across web areas and relative imports within one feature directory. Import leaf modules directly; broad barrels can hide an edge dependency in a client bundle.

## Change rules

- Preserve App Router and Cloudflare Workers compatibility; avoid Node-only APIs in edge paths.
- Keep client startup resilient to unavailable storage, stale caches, offline state, and release skew.
- Update service-worker caches and build/version behavior together when asset loading changes.
- Put shared view models at the feature boundary. Do not use `any` in production code; validate external data as `unknown` before narrowing.
- Keep accessibility labels, touch behavior, reduced-motion behavior, and desktop/mobile layouts intact.

## Verification

During iteration, run the closest unit test plus `pnpm tc`. Before completion, use the root full gate. For a user-visible change, also run the Cloudflare build and follow the root delivery rules.
