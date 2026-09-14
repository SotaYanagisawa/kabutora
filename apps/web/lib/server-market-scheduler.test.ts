import { describe, expect, it } from "vitest";
import { MARKET_QUOTE_JOB_SIZE, dedupeScheduledSecurities, isD1DailyLimitError, isMarketRefreshJob, marketRefreshBatches, scheduledQuoteTargets, selectMarketRefreshJobs } from "./server-market-scheduler";
import { MARKET_QUEUE_MESSAGE_BUDGET } from "./server-market-store";
import type { PublicSecurityDescriptor, ServerRemoteQuote } from "./server-market-types";

const security = (index: number, assetType: PublicSecurityDescriptor["assetType"] = "stock"): PublicSecurityDescriptor => ({
  securityId: `sec-us-test${index}-xnas`,
  displaySymbol: `TEST${index}`,
  providerSymbol: `TEST${index}`,
  exchangeMic: "XNAS",
  currency: "USD",
  venueCode: assetType === "fund" ? "USD_FUND" : "US",
  assetType,
});

const quote = (securityId: string, fetchedAt: string): ServerRemoteQuote => ({
  securityId,
  symbol: securityId,
  exchangeMic: "XNAS",
  currency: "USD",
  price: "100",
  previousRegularClose: "99",
  marketTimestamp: fetchedAt,
  fetchedAt,
  freshness: "near_live",
  provider: "fixture",
  session: "regular",
  priceType: "last_trade",
  venueCode: "US",
  validationStatus: "valid",
});

describe("server market scheduling", () => {
  it("does not report a budget limit when unselected jobs were already claimed", async () => {
    const candidates = [
      { version: 1 as const, claimId: "quotes:a", runId: "run", kind: "quotes" as const, securityIds: ["a"], scheduledAt: "2026-08-28T00:00:00.000Z" },
      { version: 1 as const, claimId: "history:a", runId: "run", kind: "history" as const, securityIds: ["a"], scheduledAt: "2026-08-28T00:00:00.000Z" },
    ];
    const result = await selectMarketRefreshJobs(candidates, 10, 100, async (job) => job.kind === "quotes");
    expect(result.selected).toEqual([candidates[0]]);
    expect(result.budgetLimited).toBe(false);
  });

  it("reports when provider capacity omits an otherwise claimable job", async () => {
    const candidates = [
      { version: 1 as const, claimId: "quotes:a", runId: "run", kind: "quotes" as const, securityIds: ["a"], scheduledAt: "2026-08-28T00:00:00.000Z" },
      { version: 1 as const, claimId: "benchmarks:a", runId: "run", kind: "benchmarks" as const, securityIds: [], scheduledAt: "2026-08-28T00:00:00.000Z" },
    ];
    const result = await selectMarketRefreshJobs(candidates, 10, 1, async () => true);
    expect(result.selected).toEqual([candidates[0]]);
    expect(result.budgetLimited).toBe(true);
  });

  it("defers write-heavy distribution work before exhausting the D1 reserve", async () => {
    const candidates = [
      { version: 1 as const, claimId: "quotes:a", runId: "run", kind: "quotes" as const, securityIds: ["a"], scheduledAt: "2026-08-28T00:00:00.000Z" },
      { version: 1 as const, claimId: "distributions:a", runId: "run", kind: "distributions" as const, securityIds: ["a", "b"], scheduledAt: "2026-08-28T00:00:00.000Z" },
    ];
    const result = await selectMarketRefreshJobs(candidates, 10, 100, async () => true, 500);
    expect(result.selected).toEqual([candidates[0]]);
    expect(result.budgetLimited).toBe(true);
  });

  it("fits 100-200 symbols into free-tier-safe server jobs", () => {
    expect(marketRefreshBatches(Array.from({ length: 100 }, (_, index) => String(index)), MARKET_QUOTE_JOB_SIZE)).toHaveLength(5);
    expect(marketRefreshBatches(Array.from({ length: 200 }, (_, index) => String(index)), MARKET_QUOTE_JOB_SIZE)).toHaveLength(10);
    expect(marketRefreshBatches(Array.from({ length: 200 }, (_, index) => String(index)), MARKET_QUOTE_JOB_SIZE).every((batch) => batch.length <= 20)).toBe(true);
    expect(MARKET_QUEUE_MESSAGE_BUDGET * 3 * 2).toBeLessThan(10_000);
  });

  it("refreshes active quotes after ten minutes while retaining a daily fund NAV", () => {
    const now = Date.parse("2026-08-27T16:00:00Z");
    const stock = security(1);
    const fund = security(2, "fund");
    const freshQuotes = new Map([
      [stock.securityId, quote(stock.securityId, new Date(now - 5 * 60_000).toISOString())],
      [fund.securityId, { ...quote(fund.securityId, new Date(now - 12 * 60 * 60_000).toISOString()), venueCode: "FUND", session: "closed" as const }],
    ]);
    expect(scheduledQuoteTargets([stock, fund], freshQuotes, now)).toEqual([]);
    freshQuotes.set(stock.securityId, quote(stock.securityId, new Date(now - 10 * 60_000).toISOString()));
    expect(scheduledQuoteTargets([stock, fund], freshQuotes, now)).toEqual([stock.securityId]);
  });

  it("fetches one exchange-qualified security per canonical symbol", () => {
    const exact = security(1);
    const canonical = { ...exact, securityId: "sec-us-test1" };
    expect(dedupeScheduledSecurities([canonical, exact])).toEqual([exact]);
    expect(scheduledQuoteTargets([canonical, exact], new Map(), Date.now())).toEqual([exact.securityId]);
  });

  it("accepts only the symbol-only queue schema", () => {
    const valid = {
      version: 1,
      claimId: "quotes:bucket:ids",
      runId: "run",
      kind: "quotes",
      securityIds: ["sec-us-aapl-xnas"],
      scheduledAt: "2026-08-27T16:00:00.000Z",
    };
    expect(isMarketRefreshJob(valid)).toBe(true);
    expect(isMarketRefreshJob({ ...valid, kind: "distributions" })).toBe(true);
    expect(isMarketRefreshJob({ ...valid, quantity: "100" })).toBe(false);
    expect(isMarketRefreshJob({ ...valid, securityIds: Array.from({ length: 21 }, () => "sec-us-aapl-xnas") })).toBe(false);
  });

  it("recognizes D1 daily quota failures without swallowing unrelated errors", () => {
    expect(isD1DailyLimitError(new Error("D1 database has exceeded its daily write limit"))).toBe(true);
    expect(isD1DailyLimitError(new Error("upstream request timed out"))).toBe(false);
  });
});
