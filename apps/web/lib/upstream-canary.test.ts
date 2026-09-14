import { describe, expect, it, vi } from "vitest";
import {
  runUpstreamCanary,
  validateCanaryQuote,
  type UpstreamCanaryTarget,
} from "./upstream-canary";
import type { MarketQuote } from "@kabutora/domain";

describe("upstream canary quote validation", () => {
  const validTseQuote: MarketQuote = {
    price: "2850",
    marketTimestamp: "2026-09-04T06:00:00.000Z",
    fetchedAt: "2026-09-04T06:01:00.000Z",
    freshness: "delayed",
    provider: "yahoo_chart:TSE",
    session: "regular",
    priceType: "last_trade",
    venueCode: "TSE",
    validationStatus: "valid",
  };

  const validUsQuote: MarketQuote = {
    price: "773.17",
    marketTimestamp: "2026-09-03T20:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    freshness: "near_live",
    provider: "yahoo_chart:US",
    session: "regular",
    priceType: "last_trade",
    venueCode: "US",
    validationStatus: "valid",
  };

  const validFundQuote: MarketQuote = {
    price: "38285",
    previousRegularClose: "38584",
    marketTimestamp: "2026-09-03T06:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    freshness: "delayed",
    provider: "yahoo_japan_fund_unofficial",
    session: "closed",
    priceType: "official_close",
    venueCode: "FUND",
    validationStatus: "valid",
  };

  it("passes valid quotes for all 3 targets", () => {
    expect(validateCanaryQuote("tse_stock", validTseQuote).valid).toBe(true);
    expect(validateCanaryQuote("us_equity", validUsQuote).valid).toBe(true);
    expect(validateCanaryQuote("japan_fund", validFundQuote).valid).toBe(true);
  });

  it("detects schema drift when prices are invalid, zero, or negative", () => {
    const invalidPrice = { ...validTseQuote, price: "0" };
    const res = validateCanaryQuote("tse_stock", invalidPrice);
    expect(res.valid).toBe(false);
    expect(res.driftReasons).toContain("Invalid price: 0");
  });

  it("detects schema drift when venueCode mismatches expected market", () => {
    const wrongVenue = { ...validUsQuote, venueCode: "TSE" as const };
    const res = validateCanaryQuote("us_equity", wrongVenue);
    expect(res.valid).toBe(false);
    expect(res.driftReasons[0]).toContain("Expected US venueCode");
  });

  it("detects schema drift when market timestamps are unparseable", () => {
    const badTimestamp = { ...validFundQuote, marketTimestamp: "corrupted-date" };
    const res = validateCanaryQuote("japan_fund", badTimestamp);
    expect(res.valid).toBe(false);
    expect(res.driftReasons[0]).toContain("Invalid marketTimestamp");
  });
});

describe("upstream canary orchestration", () => {
  it("reports all passed when all 3 targets respond with valid quotes", async () => {
    const report = await runUpstreamCanary({
      fetchTokyoQuote: vi.fn(async () => ({
        quote: {
          price: "2850",
          marketTimestamp: "2026-09-04T06:00:00.000Z",
          fetchedAt: "2026-09-04T06:01:00.000Z",
          freshness: "delayed" as const,
          provider: "yahoo_chart:TSE",
          session: "regular" as const,
          priceType: "last_trade" as const,
          venueCode: "TSE",
          validationStatus: "valid" as const,
        },
        intraday: [],
        shortName: "トヨタ",
        longName: "トヨタ自動車",
        exchangeLabel: "東証プライム",
      })),
      fetchUsQuote: vi.fn(async () => ({
        quote: {
          price: "773.17",
          marketTimestamp: "2026-09-03T20:00:00.000Z",
          fetchedAt: "2026-09-04T00:00:00.000Z",
          freshness: "near_live" as const,
          provider: "yahoo_chart:US",
          session: "regular" as const,
          priceType: "last_trade" as const,
          venueCode: "US",
          validationStatus: "valid" as const,
        },
        intraday: [],
        shortName: "SPY",
        longName: "SPDR S&P 500 ETF Trust",
        exchangeLabel: "NYSE Arca",
      })),
      fetchFundQuote: vi.fn(async () => ({
        quote: {
          price: "38285",
          previousRegularClose: "38584",
          marketTimestamp: "2026-09-03T06:00:00.000Z",
          fetchedAt: "2026-09-04T00:00:00.000Z",
          freshness: "delayed" as const,
          provider: "yahoo_japan_fund_unofficial",
          session: "closed" as const,
          priceType: "official_close" as const,
          venueCode: "FUND",
          validationStatus: "valid" as const,
        },
        intraday: [],
        shortName: "オルカン",
        longName: "eMAXIS Slim 全世界株式(オール・カントリー)",
        exchangeLabel: "投資信託",
      })),
    });

    expect(report.allPassed).toBe(true);
    expect(report.driftDetected).toBe(false);
    expect(report.checks).toHaveLength(3);
  });

  it("detects drift when upstream parser fails or throws", async () => {
    const report = await runUpstreamCanary({
      fetchTokyoQuote: vi.fn(async () => {
        throw new Error("HTML quote board structure changed");
      }),
      fetchUsQuote: vi.fn(async () => ({
        quote: {
          price: "773.17",
          marketTimestamp: "2026-09-03T20:00:00.000Z",
          fetchedAt: "2026-09-04T00:00:00.000Z",
          freshness: "near_live" as const,
          provider: "yahoo_chart:US",
          session: "regular" as const,
          priceType: "last_trade" as const,
          venueCode: "US",
          validationStatus: "valid" as const,
        },
        intraday: [],
        shortName: "SPY",
        longName: "SPDR S&P 500 ETF Trust",
        exchangeLabel: "NYSE Arca",
      })),
      fetchFundQuote: vi.fn(async () => ({
        quote: {
          price: "38285",
          previousRegularClose: "38584",
          marketTimestamp: "2026-09-03T06:00:00.000Z",
          fetchedAt: "2026-09-04T00:00:00.000Z",
          freshness: "delayed" as const,
          provider: "yahoo_japan_fund_unofficial",
          session: "closed" as const,
          priceType: "official_close" as const,
          venueCode: "FUND",
          validationStatus: "valid" as const,
        },
        intraday: [],
        shortName: "オルカン",
        longName: "eMAXIS Slim 全世界株式(オール・カントリー)",
        exchangeLabel: "投資信託",
      })),
    });

    expect(report.allPassed).toBe(false);
    expect(report.driftDetected).toBe(true);
    const failedCheck = report.checks.find((c) => c.target === "tse_stock");
    expect(failedCheck?.ok).toBe(false);
    expect(failedCheck?.error).toContain("HTML quote board structure changed");
  });
});
