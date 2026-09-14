import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYahooJapanQuotePage, tokyoMarketTimestamp, tokyoPtsTimestamp } from "./yahoo-market";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resilient Yahoo market adapter", () => {
  it("parses the normalized Yahoo Japan price board from Next flight data", () => {
    const flight = `6:{"priceBoard":{"currentKey":"detail","board":{"codeWithMarketExtension":"285A.T","label":"東証PRM","price":{"value":"50,730"},"priceChange":{"value":"2,720"},"japanUpdateTime":"15:30","delayMinutes":0},"ptsPrice":"51,200","ptsUpdateTime":"8/12 18:23","navItems":[]}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`;

    expect(parseYahooJapanQuotePage(html)).toMatchObject({
      codeWithMarketExtension: "285A.T",
      price: { value: "50,730" },
      priceChange: { value: "2,720" },
      japanUpdateTime: "15:30",
      ptsPrice: "51,200",
      ptsUpdateTime: "8/12 18:23",
    });
  });

  it("uses a real Japannext night-PTS trade instead of the TSE close", async () => {
    const flight = `6:{"priceBoard":{"currentKey":"detail","board":{"codeWithMarketExtension":"9999.T","label":"東証PRM","price":{"value":"1,000"},"priceChange":{"value":"20"},"japanUpdateTime":"15:30","delayMinutes":0},"ptsPrice":"1,025.5","ptsUpdateTime":"8/12 18:23","navItems":[]}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, { status: 200 })));
    vi.stubGlobal("caches", undefined);
    vi.setSystemTime(new Date("2026-08-12T09:24:00Z"));
    const quote = (await import("./yahoo-market")).getYahooJapanQuoteBundle("9999.T", "sec-pts", true, "pts_night");
    await expect(quote).resolves.toMatchObject({
      quote: { price: "1025.5", session: "pts_night", venueCode: "JNX", previousRegularClose: "980" },
      exchangeLabel: "東証PRM",
    });
    vi.useRealTimers();
  });

  it("keeps the active PTS session hot when a ticker has no PTS trade", async () => {
    const flight = `6:{"priceBoard":{"currentKey":"detail","board":{"codeWithMarketExtension":"9998.T","label":"東証PRM","price":{"value":"1,000"},"priceChange":{"value":"20"},"japanUpdateTime":"15:30","delayMinutes":0},"navItems":[]}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, { status: 200 })));
    vi.stubGlobal("caches", undefined);
    const result = await (await import("./yahoo-market")).getYahooJapanQuoteBundle("9998.T", "sec-no-pts", true, "pts_night");
    expect(result.quote).toMatchObject({ price: "1000", session: "pts_night", venueCode: "TSE", priceType: "official_close" });
  });

  it("retains a successful edge response for stale fallback beyond its freshness TTL", async () => {
    const entries = new Map<string, Response>();
    const edgeCache = {
      match: vi.fn(async (request: RequestInfo | URL) => entries.get(String(request))?.clone()),
      put: vi.fn(async (request: RequestInfo | URL, response: Response) => { entries.set(String(request), response.clone()); }),
    };
    vi.stubGlobal("caches", { default: edgeCache });
    const payload = {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 123,
            previousClose: 120,
            regularMarketTime: Math.floor(Date.now() / 1000),
          },
          timestamp: [Math.floor(Date.now() / 1000)],
          indicators: { quote: [{ close: [123] }] },
        }],
        error: null,
      },
    };
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockRejectedValue(new Error("temporary upstream outage"));
    vi.stubGlobal("fetch", providerFetch);

    const firstModule = await import("./yahoo-market");
    const first = await firstModule.getYahooQuoteBundle("RESILIENT", "sec-test", "US");
    const cachedResponse = [...entries.values()][0];
    vi.resetModules();
    const coldModule = await import("./yahoo-market");
    const second = await coldModule.getYahooQuoteBundle("RESILIENT", "sec-test", "US", true);

    expect(first.quote.price).toBe("123");
    expect(cachedResponse.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(Number(cachedResponse.headers.get("X-Kabutora-Fresh-Until"))).toBeGreaterThan(Date.now());
    expect(second.quote.price).toBe("123");
    expect(second.quote.provider).toBe("yahoo_chart_unofficial:edge");
    expect(second.quote.freshness).toBe("cached");
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("treats a USD mutual fund NAV as a daily quote without intraday bars", async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const payload = {
      chart: {
        result: [{
          meta: { regularMarketPrice: 713.71, previousClose: 712.45, regularMarketTime: timestamp },
          timestamp: [timestamp],
          indicators: { quote: [{ close: [713.71] }] },
        }],
        error: null,
      },
    };
    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", providerFetch);
    vi.stubGlobal("caches", undefined);

    const result = await (await import("./yahoo-market")).getYahooQuoteBundle("VFIAX", "sec-us-fund-vfiax", "FUND", true);

    expect(result.quote).toMatchObject({ price: "713.71", session: "closed", priceType: "official_close", venueCode: "FUND" });
    expect(result.intraday).toEqual([]);
    expect(String(providerFetch.mock.calls[0]?.[0])).toContain("interval=1d");
  });

  it("merges rolling daily history into a canonical edge series for cold-start recovery", async () => {
    const entries = new Map<string, Response>();
    const edgeCache = {
      match: vi.fn(async (request: RequestInfo | URL) => entries.get(String(request))?.clone()),
      put: vi.fn(async (request: RequestInfo | URL, response: Response) => { entries.set(String(request), response.clone()); }),
    };
    vi.stubGlobal("caches", { default: edgeCache });
    const day = 24 * 60 * 60;
    const start = Math.floor(Date.now() / 1000) - 3 * day;
    const payload = (timestamps: number[], closes: number[]) => ({
      chart: {
        result: [{
          meta: { regularMarketPrice: closes.at(-1), regularMarketTime: timestamps.at(-1) },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] },
        }],
        error: null,
      },
    });
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload([start, start + day], [100, 101])), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload([start + 2 * day], [102])), { status: 200 }))
      .mockRejectedValue(new Error("history provider unavailable"));
    vi.stubGlobal("fetch", providerFetch);

    const warmModule = await import("./yahoo-market");
    await warmModule.getYahooHistory("ROLLING", "sec-rolling", start - day, start + 2 * day, true);
    await warmModule.getYahooHistory("ROLLING", "sec-rolling", start + day, start + 4 * day, true);
    vi.resetModules();
    const coldModule = await import("./yahoo-market");
    const recovered = await coldModule.getYahooHistory("ROLLING", "sec-rolling", start - day, start + 4 * day, true);

    expect(entries).toHaveLength(1);
    expect(recovered.bars.map((bar) => bar.close)).toEqual(["100", "101", "102"]);
    expect(recovered.cacheState).toBe("stale");
    expect(recovered.providerHost).toBe("edge");
  });

  it("normalizes Yahoo cash dividends from the existing daily-history response", async () => {
    const timestamp = Math.floor(new Date("2026-03-10T06:00:00Z").getTime() / 1000);
    const payload = {
      chart: {
        result: [{
          meta: { currency: "USD", firstTradeDate: timestamp - 86_400 },
          timestamp: [timestamp],
          indicators: { quote: [{ close: [100] }], adjclose: [{ adjclose: [99] }] },
          events: { dividends: { [timestamp]: { date: timestamp, amount: 1.25 } } },
        }],
        error: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    vi.stubGlobal("caches", undefined);

    const result = await (await import("./yahoo-market")).getYahooHistory("AAPL", "sec-aapl", timestamp - 86_400, timestamp + 86_400, true);

    expect(result.distributions).toEqual([expect.objectContaining({
      id: `sec-aapl-cash_dividend-${timestamp}`,
      securityId: "sec-aapl",
      type: "CASH_DIVIDEND",
      exDate: "2026-03-10",
      amountPerUnit: "1.25",
      distributionUnit: "1",
      currency: "USD",
      confidence: "reported",
    })]);
  });

  describe("tokyoMarketTimestamp", () => {
    it("preserves today's date during or after market session when updateTime has passed", () => {
      // Friday 2026-09-04 15:35:00 JST
      const now = new Date("2026-09-04T06:35:00.000Z");
      expect(tokyoMarketTimestamp("15:30", now)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("rolls back weekend to Friday close instead of stamping Saturday or Sunday", () => {
      // Saturday 2026-09-05 12:00:00 JST
      const saturday = new Date("2026-09-05T03:00:00.000Z");
      expect(tokyoMarketTimestamp("15:30", saturday)).toBe("2026-09-04T06:30:00.000Z");

      // Sunday 2026-09-06 12:00:00 JST
      const sunday = new Date("2026-09-06T03:00:00.000Z");
      expect(tokyoMarketTimestamp("15:30", sunday)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("rolls back Monday morning before market close to Friday close (preventing future timestamps)", () => {
      // Monday 2026-09-07 08:30:00 JST (before market open, quote says 15:30)
      const mondayMorning = new Date("2026-09-06T23:30:00.000Z");
      expect(tokyoMarketTimestamp("15:30", mondayMorning)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("assigns Monday date when current time is after the trade time on Monday", () => {
      // Monday 2026-09-07 09:15:00 JST (after 09:10 trade)
      const mondayTrading = new Date("2026-09-07T00:15:00.000Z");
      expect(tokyoMarketTimestamp("09:10", mondayTrading)).toBe("2026-09-07T00:10:00.000Z");
    });

    it("parses M/D format (such as 9/4) on weekends to TSE close 15:30 JST without returning now", () => {
      // Saturday 2026-09-05 10:00:00 JST
      const saturday = new Date("2026-09-05T01:00:00.000Z");
      expect(tokyoMarketTimestamp("9/4", saturday)).toBe("2026-09-04T06:30:00.000Z");
      expect(tokyoMarketTimestamp("09/04", saturday)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("parses M/D H:mm format to exact Tokyo timestamp", () => {
      const saturday = new Date("2026-09-05T01:00:00.000Z");
      expect(tokyoMarketTimestamp("9/4 15:30", saturday)).toBe("2026-09-04T06:30:00.000Z");
    });
  });

  describe("tokyoPtsTimestamp", () => {
    it("parses M/D H:mm night PTS timestamp", () => {
      const now = new Date("2026-09-05T01:00:00.000Z");
      expect(tokyoPtsTimestamp("9/4 23:56", now)).toBe("2026-09-04T14:56:00.000Z");
      expect(tokyoPtsTimestamp("9/5 01:30", now)).toBe("2026-09-04T16:30:00.000Z");
    });

    it("parses H:mm format on Saturday morning rolling back to Friday night", () => {
      // Saturday 2026-09-05 08:00 JST
      const saturdayMorning = new Date("2026-09-04T23:00:00.000Z");
      expect(tokyoPtsTimestamp("23:56", saturdayMorning)).toBe("2026-09-04T14:56:00.000Z");
    });
  });

  it("adopts Friday night PTS trade on weekends when TSE is closed", async () => {
    // Upstream chart payload returns TSE close at 15:30
    const chartPayload = {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 3081,
            previousClose: 3080,
            regularMarketTime: 1788503400, // 2026-09-04 15:30 JST (06:30 UTC)
            exchangeName: "JPX",
          },
          timestamp: [1788503400],
          indicators: { quote: [{ close: [3081] }] },
        }],
        error: null,
      },
    };
    // Japan board returns Friday night PTS trade at 23:56 JST
    const flight = `6:{"priceBoard":{"currentKey":"detail","board":{"codeWithMarketExtension":"7203.T","label":"東証PRM","price":{"value":"3,081"},"priceChange":{"value":"1"},"japanUpdateTime":"9/4","delayMinutes":0},"ptsPrice":"3,080","ptsUpdateTime":"9/4 23:56","navItems":[]}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`;

    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const str = String(url);
      if (str.includes("finance.yahoo.co.jp")) {
        return Promise.resolve(new Response(html, { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(chartPayload), { status: 200 }));
    }));
    vi.stubGlobal("caches", undefined);
    // Simulate Saturday afternoon 2026-09-05 14:00 JST
    vi.setSystemTime(new Date("2026-09-05T05:00:00.000Z"));

    const bundle = await (await import("./yahoo-market")).getYahooQuoteBundle("7203.T", "sec-7203", "TSE", true);
    expect(bundle.quote).toMatchObject({
      price: "3080",
      venueCode: "JNX",
      session: "closed",
      marketTimestamp: "2026-09-04T14:56:00.000Z", // 23:56 JST
      provider: "yahoo_japan_pts_html:network",
    });
    // Intraday includes both the TSE close and the PTS bar
    expect(bundle.intraday.at(-1)).toMatchObject({
      price: "3080",
      timestamp: "2026-09-04T14:56:00.000Z",
    });
    vi.useRealTimers();
  });
});
