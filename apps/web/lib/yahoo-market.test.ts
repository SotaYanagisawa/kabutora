import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYahooJapanQuotePage } from "./yahoo-market";

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
});
