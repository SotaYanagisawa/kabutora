# Accounting Domain Guide

`packages/domain` is a pure TypeScript package. It must have no browser, React, Next.js, Cloudflare, Firebase, filesystem, or network dependency.

- Use `Decimal` for quantities, prices, cost basis, currency conversion, gains, totals, ratios, and split factors.
- Keep calculations deterministic and side-effect free. Inputs are immutable; return new values when adjustments are required.
- Preserve extended caller fields when a transformation accepts a subtype of a public domain type. Prefer generic transforms over narrowing results to the base type.
- Keep transaction ordering deterministic with date plus stable ID tie-breakers.
- Treat public types and exports as compatibility surfaces. Extend them carefully and never silently reinterpret stored data.
- Cover FIFO lots, account cost-basis groups, partial sales, splits/reverse splits, dividends, missing quotes, currencies, and zero quantities when relevant.

Run `pnpm test:domain` while iterating. Use the root full gate before completion.
