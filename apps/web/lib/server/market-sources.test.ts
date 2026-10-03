import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRequestedSecurity } from "../market/market-security";
import recorded from "./fixtures/yahoo-spark-1d.json";
import { fetchSpark, parseSpark, quoteFromSpark, type SparkResult } from "./market-sources";

afterEach(() => vi.unstubAllGlobals());

const toyota = normalizeRequestedSecurity("sec-7203")!;
const apple = normalizeRequestedSecurity("sec-us-aapl")!;

describe("Yahoo spark parsing (recorded 2026-10-02 payload)", () => {
  const parsed = parseSpark(recorded);

  it("reads every symbol and drops null closes", () => {
    expect([...parsed.keys()]).toEqual(["7203.T", "AAPL"]);
    expect(parsed.get("7203.T")!.p).toEqual([2866, 2869.5, 2869.5, 2864, 2867]);
    expect(parsed.get("7203.T")!.t).toHaveLength(5);
  });

  it("uses the official close after the TSE session instead of the last 5-minute bar", () => {
    const quote = quoteFromSpark(toyota, parsed.get("7203.T")!, 1_790_930_000_000)!;
    expect(quote).toMatchObject({ securityId: "sec-7203", price: "2856.5", previousRegularClose: "2925", session: "closed", priceType: "official_close", venueCode: "TSE", validationStatus: "valid", longName: "Toyota Motor Corporation" });
    expect(quote.marketTimestamp).toBe("2026-10-02T06:30:00.000Z");
  });

  it("uses the latest after-hours trade during the US post-market session", () => {
    const quote = quoteFromSpark(apple, parsed.get("AAPL")!, 1_790_985_400_000)!;
    expect(quote).toMatchObject({ price: "333.54", session: "after_hours", freshness: "live", priceType: "last_trade", previousRegularClose: "330.32" });
  });
});

describe("quote validation", () => {
  const spark = (overrides: Partial<SparkResult["meta"]>, p: number[]): SparkResult => ({
    symbol: "7203.T",
    meta: { regularMarketPrice: 100, regularMarketTime: 1_000, previousClose: 100, currentTradingPeriod: { regular: { start: 0, end: 10_000 } }, ...overrides },
    t: p.map((_, index) => 900 + index),
    p,
  });

  it("repairs an isolated bad tick with the provider's regular-market price", () => {
    expect(quoteFromSpark(toyota, spark({}, [101, 5]), 2_000_000)).toMatchObject({ price: "100", validationStatus: "valid" });
  });

  it("flags a >35% move as suspect rather than hiding it", () => {
    expect(quoteFromSpark(toyota, spark({ regularMarketPrice: 200 }, [200]), 2_000_000)).toMatchObject({ price: "200", validationStatus: "suspect" });
  });

  it("returns null when the provider has no usable price", () => {
    expect(quoteFromSpark(toyota, { symbol: "7203.T", meta: {}, t: [], p: [] }, 2_000_000)).toBeNull();
  });
});

describe("spark batching", () => {
  it("fetches 45 symbols in three parallel 20-symbol calls and falls back to the second host", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.hostname);
      if (url.hostname === "query1.finance.yahoo.com") return new Response("busy", { status: 429 });
      const symbols = url.searchParams.get("symbols")!.split(",");
      expect(symbols.length).toBeLessThanOrEqual(20);
      return Response.json({ spark: { result: symbols.map((symbol) => ({ symbol, response: [{ meta: { regularMarketPrice: 1, regularMarketTime: 1 }, timestamp: [1], indicators: { quote: [{ close: [1] }] } }] })) } });
    }));
    const symbols = Array.from({ length: 45 }, (_, index) => `${1000 + index}.T`);
    const result = await fetchSpark(symbols, "1d", "5m");
    expect(result.size).toBe(45);
    expect(calls.filter((host) => host === "query2.finance.yahoo.com")).toHaveLength(3);
    expect(calls).toHaveLength(6);
  });
});
