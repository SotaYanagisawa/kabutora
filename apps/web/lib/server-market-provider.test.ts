import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchMarketBenchmarks,
  getUsQuoteBundleWithFallback,
} from "./server-market-provider";
import * as yahooMarketModule from "./yahoo-market";
import * as cnbcProviderModule from "./cnbc-quote-provider";
import type { MarketQuote } from "@kabutora/domain";

describe("server-market-provider US & global fallback", () => {
  const mockYahooValidQuote: MarketQuote = {
    price: "773.17",
    marketTimestamp: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    freshness: "near_live",
    provider: "yahoo_chart:US",
    session: "regular",
    priceType: "last_trade",
    venueCode: "US",
    validationStatus: "valid",
  };

  const mockYahooSuspectQuote: MarketQuote = {
    ...mockYahooValidQuote,
    price: "1200.00",
    validationStatus: "suspect",
  };

  const mockCnbcValidQuote: MarketQuote = {
    price: "774.50",
    previousRegularClose: "770.00",
    marketTimestamp: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    freshness: "near_live",
    provider: "cnbc_rest:fallback",
    session: "regular",
    priceType: "last_trade",
    venueCode: "US",
    validationStatus: "valid",
  };

  it("returns Yahoo quote bundle when primary provider succeeds without suspect status", async () => {
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockResolvedValueOnce({
      quote: mockYahooValidQuote,
      intraday: [],
    });
    const cnbcSpy = vi.spyOn(cnbcProviderModule, "fetchCnbcQuote");

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    expect(result.quote.provider).toBe("yahoo_chart:US");
    expect(result.quote.price).toBe("773.17");
    expect(cnbcSpy).not.toHaveBeenCalled();
  });

  it("falls back to CNBC when Yahoo Finance throws an error", async () => {
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockRejectedValueOnce(
      new Error("Yahoo HTTP 429 Too Many Requests"),
    );
    vi.spyOn(cnbcProviderModule, "fetchCnbcQuote").mockResolvedValueOnce({
      quote: mockCnbcValidQuote,
      shortName: "SPY",
    });

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    expect(result.quote.provider).toBe("cnbc_rest:fallback");
    expect(result.quote.price).toBe("774.50");
    expect(result.shortName).toBe("SPY");
  });

  it("falls back to CNBC when Yahoo Finance returns a suspect price jump", async () => {
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockResolvedValueOnce({
      quote: mockYahooSuspectQuote,
      intraday: [],
    });
    vi.spyOn(cnbcProviderModule, "fetchCnbcQuote").mockResolvedValueOnce({
      quote: mockCnbcValidQuote,
    });

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    expect(result.quote.provider).toBe("cnbc_rest:fallback");
    expect(result.quote.price).toBe("774.50");
    expect(result.quote.validationStatus).toBe("valid");
  });

  it("falls back to CNBC when primary provider returns a stale quote even if price passes validation", async () => {
    const mockYahooStaleQuote: MarketQuote = {
      ...mockYahooValidQuote,
      freshness: "stale",
      validationStatus: "valid",
    };
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockResolvedValueOnce({
      quote: mockYahooStaleQuote,
      intraday: [
        { securityId: "sec-us-spy", timestamp: "2026-09-03T18:00:00.000Z", price: "770.00", provider: "yahoo_chart:US" },
      ],
    });
    vi.spyOn(cnbcProviderModule, "fetchCnbcQuote").mockResolvedValueOnce({
      quote: {
        ...mockCnbcValidQuote,
        marketTimestamp: "2026-09-04T13:30:00.000Z",
        price: "775.00",
        freshness: "live",
      },
    });

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    expect(result.quote.provider).toBe("cnbc_rest:fallback");
    expect(result.quote.price).toBe("775.00");
    // Persists fallback quote as a real intraday observation using its original timestamp, merged with existing
    expect(result.intraday).toHaveLength(2);
    expect(result.intraday[1]).toMatchObject({
      securityId: "sec-us-spy",
      timestamp: "2026-09-04T13:30:00.000Z",
      price: "775.00",
      provider: "cnbc_rest:fallback",
    });
  });

  it("merges repeated fallback observations without duplicating timestamps or erasing history", async () => {
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockRejectedValueOnce(new Error("Yahoo rate limit"));
    vi.spyOn(cnbcProviderModule, "fetchCnbcQuote").mockResolvedValueOnce({
      quote: {
        ...mockCnbcValidQuote,
        marketTimestamp: "2026-09-04T13:30:00.000Z",
        price: "775.00",
      },
    });

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    expect(result.intraday).toEqual([
      expect.objectContaining({
        securityId: "sec-us-spy",
        timestamp: "2026-09-04T13:30:00.000Z",
        price: "775.00",
        provider: "cnbc_rest:fallback",
      }),
    ]);
  });

  it("preserves newer extended-hours bars from primary when fallback is used", async () => {
    const mockYahooStaleQuote: MarketQuote = {
      ...mockYahooValidQuote,
      freshness: "stale",
      marketTimestamp: "2026-09-04T13:00:00.000Z",
    };
    const primaryIntraday = [
      { securityId: "sec-us-spy", timestamp: "2026-09-04T13:00:00.000Z", price: "770.00", provider: "yahoo" },
      { securityId: "sec-us-spy", timestamp: "2026-09-04T20:30:00.000Z", price: "778.00", provider: "yahoo", session: "after_hours" as const },
    ];
    vi.spyOn(yahooMarketModule, "getYahooQuoteBundle").mockResolvedValueOnce({
      quote: mockYahooStaleQuote,
      intraday: primaryIntraday,
    });
    vi.spyOn(cnbcProviderModule, "fetchCnbcQuote").mockResolvedValueOnce({
      quote: {
        ...mockCnbcValidQuote,
        marketTimestamp: "2026-09-04T13:30:00.000Z",
        price: "775.00",
        freshness: "live",
      },
    });

    const result = await getUsQuoteBundleWithFallback("SPY", "sec-us-spy", "US", false);
    // Intraday has the 13:00 bar, the 13:30 fallback observation, AND the 20:30 extended-hours bar
    expect(result.intraday).toHaveLength(3);
    expect(result.intraday.map((b) => b.timestamp)).toEqual([
      "2026-09-04T13:00:00.000Z",
      "2026-09-04T13:30:00.000Z",
      "2026-09-04T20:30:00.000Z",
    ]);
  });
});
