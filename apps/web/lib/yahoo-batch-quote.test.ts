import { describe, expect, it } from "vitest";
import { normalizeBatchQuote, type YahooBatchRawQuote } from "./yahoo-batch-quote";

describe("Yahoo Batch Quote Normalization", () => {
  it("correctly normalizes standard Japanese equity quote", () => {
    const raw: YahooBatchRawQuote = {
      symbol: "7203.T",
      shortName: "TOYOTA MOTOR CORP",
      longName: "Toyota Motor Corporation",
      regularMarketPrice: 2850.5,
      regularMarketPreviousClose: 2800.0,
      regularMarketOpen: 2810.0,
      regularMarketDayHigh: 2860.0,
      regularMarketDayLow: 2805.0,
      regularMarketVolume: 12500000,
      regularMarketTime: 1715000000,
      marketState: "REGULAR",
      currency: "JPY",
      exchangeName: "Tokyo",
    };

    const normalized = normalizeBatchQuote(raw, "TSE", "2026-05-01T06:00:00.000Z", "query1");
    expect(normalized).not.toBeNull();
    expect(normalized?.quote.price).toBe("2850.5");
    expect(normalized?.quote.previousRegularClose).toBe("2800");
    expect(normalized?.quote.dayOpen).toBe("2810");
    expect(normalized?.quote.session).toBe("regular");
    expect(normalized?.quote.venueCode).toBe("TSE");
    expect(normalized?.shortName).toBe("TOYOTA MOTOR CORP");
  });

  it("normalizes US stock quote", () => {
    const raw: YahooBatchRawQuote = {
      symbol: "AAPL",
      shortName: "Apple Inc.",
      regularMarketPrice: 195.2,
      regularMarketPreviousClose: 194.0,
      regularMarketTime: 1715000000,
      marketState: "CLOSED",
      currency: "USD",
      exchangeName: "NasdaqGS",
    };

    const normalized = normalizeBatchQuote(raw, "US", "2026-05-01T06:00:00.000Z", "query1");
    expect(normalized).not.toBeNull();
    expect(normalized?.quote.price).toBe("195.2");
    expect(normalized?.quote.session).toBe("closed");
    expect(normalized?.quote.priceType).toBe("official_close");
  });

  it("returns null for quotes missing price or timestamp", () => {
    const rawMissingPrice: YahooBatchRawQuote = {
      symbol: "XYZ",
      regularMarketTime: 1715000000,
    };
    expect(normalizeBatchQuote(rawMissingPrice, "US")).toBeNull();

    const rawMissingTime: YahooBatchRawQuote = {
      symbol: "XYZ",
      regularMarketPrice: 100,
    };
    expect(normalizeBatchQuote(rawMissingTime, "US")).toBeNull();
  });
});
