import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CATALOG, MarketHub, MemoryMarketStore, serveMarket } from "./market-hub";

/** Deterministic fake upstream: Yahoo spark/chart, Yahoo Japan TOPIX board, Japannext PTS. */
const upstream = { calls: [] as string[], fail: false, now: 0, tseOpen: true, ptsLast: "3050", pageDelayMs: 0 };
const HOUR = 3_600;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

function sparkPayload(symbols: string[], days: number, step: number) {
  const now = Math.floor(upstream.now / 1000);
  const marketTime = upstream.tseOpen ? now - 60 : now - 4 * HOUR;
  return {
    spark: {
      result: symbols.map((symbol) => {
        const count = days === 1 ? 78 : 130;
        const timestamp = range(count).map((index) => marketTime - (count - 1 - index) * step);
        return {
          symbol,
          response: [{
            meta: {
              regularMarketPrice: 3000, regularMarketTime: marketTime, previousClose: 2990, exchangeName: "FIX", shortName: symbol,
              currentTradingPeriod: { regular: { start: now - 6 * HOUR, end: upstream.tseOpen ? now + HOUR : now - 4 * HOUR } },
            },
            timestamp,
            indicators: { quote: [{ close: timestamp.map((_, index) => 3000 + (index % 7)) }] },
          }],
        };
      }),
    },
  };
}

function chartPayload(url: URL) {
  const start = Date.UTC(2015, 0, 5) / 1000;
  const months = range(140).map((index) => start + index * 30 * 86_400);
  const dividends = url.searchParams.get("interval") === "1mo" ? { [months[100]]: { amount: 0.25, date: months[100] } } : {};
  return { chart: { result: [{ meta: { currency: "USD", firstTradeDate: start }, timestamp: months, indicators: { quote: [{ close: months.map(() => 100) }], adjclose: [{ adjclose: months.map(() => 99) }] }, events: { dividends } }] } };
}

async function fakeFetch(input: string | URL) {
  const url = new URL(String(input));
  upstream.calls.push(`${url.hostname}${url.pathname}?${url.searchParams.get("range") ?? url.searchParams.get("interval") ?? ""}`);
  if (upstream.fail) throw new Error("upstream_down");
  if (url.pathname === "/v7/finance/spark") {
    const days = url.searchParams.get("range") === "5d" ? 5 : 1;
    return Response.json(sparkPayload(url.searchParams.get("symbols")!.split(","), days, days === 1 ? 300 : 900));
  }
  if (url.pathname.startsWith("/v8/finance/chart/")) return Response.json(chartPayload(url));
  if (url.hostname === "finance.yahoo.co.jp") {
    if (upstream.pageDelayMs) await new Promise((resolve) => setTimeout(resolve, upstream.pageDelayMs));
    return new Response('<script>"mainDomesticIndexPriceBoard":{"price":"3,100.5","changePriceRate":"+0.50","japanUpdateTime":"15:30"}</script>');
  }
  if (url.hostname === "www.japannext.co.jp") {
    return new Response(`var mdata = new Array();\nmdata[ 1 ] = [ "7203", "", "", "", "3040", "3060", "3030", "${upstream.ptsLast}", "1200.0" ];\n`, { headers: { "Last-Modified": new Date(upstream.now - 30_000).toUTCString() } });
  }
  return new Response("not found", { status: 404 });
}

// Saturday 12:00 JST: no PTS session, so call counts are spark + TOPIX only.
const WEEKEND = Date.parse("2026-10-03T03:00:00Z");
function setup(now = WEEKEND, store = new MemoryMarketStore()) {
  upstream.now = now;
  return { hub: new MarketHub(store, { now: () => upstream.now }), store };
}
const largeCatalog = [...range(100).map((index) => `sec-${1300 + index}`), ...range(100).map((index) => `sec-us-t${index}`)];

beforeEach(() => {
  Object.assign(upstream, { calls: [], fail: false, tseOpen: true, ptsLast: "3050", pageDelayMs: 0 });
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => vi.unstubAllGlobals());

describe("snapshot performance contract", () => {
  it("prices 200 symbols, FX and every benchmark within the free-plan subrequest budget", async () => {
    const { hub } = setup();
    expect((await hub.register(largeCatalog)).size).toBe(MAX_CATALOG);
    const result = await hub.snapshot();
    expect(result.snapshot.quotes).toHaveLength(201);
    expect(result.snapshot.failures).toEqual([]);
    expect(result.snapshot.benchmarks.map((benchmark) => benchmark.id).sort()).toEqual(["cny-jpy", "dow", "nasdaq", "nikkei225", "sp500", "topix", "usd-jpy"]);
    // 11 one-day + 11 five-day spark batches + TOPIX; Workers Free stops at 50.
    expect(upstream.calls.length).toBeLessThanOrEqual(25);
  });

  it("keeps the payload small: full snapshot under 1.5 MB, a one-minute delta under 150 KB", async () => {
    const { hub } = setup();
    await hub.register(largeCatalog);
    const { snapshot, body } = await hub.snapshot();
    const latest = Math.max(...snapshot.series.map((item) => item.t.at(-1)!));
    expect(body.length).toBeLessThan(1_500_000);
    expect(hub.encode(snapshot, latest - 60).length).toBeLessThan(150_000);
  });

  it("shares one upstream refresh between concurrent readers", async () => {
    const { hub } = setup();
    await hub.register(largeCatalog);
    const results = await Promise.all(range(20).map(() => hub.snapshot()));
    expect(new Set(results.map((result) => result.snapshot.revision)).size).toBe(1);
    expect(upstream.calls.length).toBeLessThanOrEqual(25);
  });

  it("serves a warm snapshot with zero upstream calls and refreshes only today's prices after 15 s", async () => {
    const { hub } = setup();
    await hub.register(largeCatalog);
    await hub.snapshot();
    const afterCold = upstream.calls.length;
    await hub.snapshot();
    expect(upstream.calls.length).toBe(afterCold);
    upstream.now += 20_000;
    await hub.snapshot();
    const refresh = upstream.calls.slice(afterCold);
    expect(refresh.length).toBe(Math.ceil((201 + 5) / 20));
    expect(refresh.every((call) => call.endsWith("/v7/finance/spark?1d"))).toBe(true);
  });
});

describe("resilience", () => {
  it("keeps the last prices through an upstream outage and across an object restart", async () => {
    const { hub, store } = setup();
    await hub.register(["sec-7203", "sec-us-aapl"]);
    const before = await hub.snapshot();
    upstream.fail = true;
    upstream.now += 20_000;
    const during = await hub.snapshot();
    expect(during.snapshot.quotes.map((quote) => quote.price)).toEqual(before.snapshot.quotes.map((quote) => quote.price));
    expect(during.snapshot.failures.map((failure) => failure.message)).toContain("market_quote_stale");
    const restarted = new MarketHub(store, { now: () => upstream.now });
    expect((await restarted.snapshot()).snapshot.quotes).toHaveLength(3);
  });

  it("does not let slow page scrapes delay prices after a restart", async () => {
    const { hub, store } = setup();
    await hub.register(["sec-7203", "sec-us-aapl"]);
    await hub.snapshot();
    upstream.pageDelayMs = 3_000;
    upstream.now += 10 * 60_000;
    const restarted = new MarketHub(store, { now: () => upstream.now });
    const started = performance.now();
    const { snapshot } = await restarted.snapshot();
    expect(performance.now() - started).toBeLessThan(500);
    expect(snapshot.benchmarks.find((benchmark) => benchmark.id === "topix")?.value).toBe(3100.5);
  });
});

describe("catalog", () => {
  it("stores canonical ids, ignores FX and duplicates, and enforces the 200-symbol cap", async () => {
    const { hub } = setup();
    expect(await hub.register(["sec-7203-xtks", "7203.T", "sec-fx-usdjpy", "nonsense"])).toEqual({ added: ["sec-7203"], rejected: ["nonsense"], size: 1 });
    await hub.register(largeCatalog);
    expect((await hub.register(["sec-us-overflow"])).rejected).toEqual(["sec-us-overflow"]);
  });

  it("seeds the catalog once from the legacy registry", async () => {
    const seedCatalog = vi.fn(async () => ["sec-7203-xtks", "sec-us-aapl-xnas", "sec-7203"]);
    const hub = new MarketHub(new MemoryMarketStore(), { seedCatalog });
    expect(await hub.catalogIds()).toEqual(["sec-7203", "sec-us-aapl"]);
    expect(await hub.catalogIds()).toEqual(["sec-7203", "sec-us-aapl"]);
    expect(seedCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("Japannext PTS", () => {
  // Friday 20:00 JST: the night session is open and the TSE is closed.
  const NIGHT = Date.parse("2026-10-02T11:00:00Z");

  it("uses the newer night-session trade as the latest Japanese price and charts it", async () => {
    upstream.tseOpen = false;
    const { hub } = setup(NIGHT);
    await hub.register(["sec-7203"]);
    const { snapshot } = await hub.snapshot();
    expect(snapshot.quotes.find((quote) => quote.securityId === "sec-7203")).toMatchObject({ price: "3050", session: "pts_night", venueCode: "JNX", provider: "japannext_pts_public" });
    expect(snapshot.series.find((item) => item.session === "pts_night")).toMatchObject({ id: "sec-7203", venueCode: "JNX_NIGHT", p: [3050] });
  });

  it("ignores an implausible PTS print", async () => {
    upstream.tseOpen = false;
    upstream.ptsLast = "9000";
    const { hub } = setup(NIGHT);
    await hub.register(["sec-7203"]);
    expect((await hub.snapshot()).snapshot.quotes.find((quote) => quote.securityId === "sec-7203")?.venueCode).toBe("TSE");
  });
});

describe("HTTP contract", () => {
  const request = (path: string, init?: RequestInit) => new Request(`https://kabutora.test/api/market/${path}`, init);

  it("answers an unchanged revision with 304 and an incremental request with only new points", async () => {
    const { hub } = setup();
    await hub.register(["sec-us-aapl"]);
    const first = await serveMarket(request("snapshot"), hub, { maxRegister: 1 });
    const body = await first.json() as { full: boolean; catalogKey: string; series: Array<{ t: number[] }> };
    expect(body.full).toBe(true);
    const etag = first.headers.get("ETag")!;
    expect((await serveMarket(request("snapshot", { headers: { "If-None-Match": etag } }), hub, { maxRegister: 1 })).status).toBe(304);
    const last = body.series[0].t.reduce((sum, delta) => sum + delta, 0);
    const delta = await (await serveMarket(request(`snapshot?since=${last}&catalog=${body.catalogKey}`), hub, { maxRegister: 1 })).json() as { full: boolean; series: Array<{ t: number[] }> };
    expect(delta.full).toBe(false);
    expect(delta.series.every((item) => item.t.length === 1)).toBe(true);
    const otherCatalog = await (await serveMarket(request(`snapshot?since=${last}&catalog=stale`), hub, { maxRegister: 1 })).json() as { full: boolean };
    expect(otherCatalog.full).toBe(true);
  });

  it("accepts only a bounded list of public ids at the registry", async () => {
    const { hub } = setup();
    const post = (body: unknown) => serveMarket(request("registry", { method: "POST", body: JSON.stringify(body) }), hub, { maxRegister: 1 });
    expect((await post({ securityIds: ["sec-7203"] })).status).toBe(200);
    expect((await post({ securityIds: ["sec-7203", "sec-us-aapl"] })).status).toBe(400);
    expect((await post({ securityIds: ["sec-7203"], quantity: "100" })).status).toBe(400);
    expect((await post(["sec-7203"])).status).toBe(400);
  });

  it("reports health without symbols", async () => {
    const { hub } = setup();
    const health = await (await serveMarket(request("health"), hub, { maxRegister: 1 })).json();
    expect(Object.keys(health).sort()).toEqual(["ageSeconds", "generatedAt", "quotes", "status"]);
  });
});

describe("history and dividends", () => {
  it("fills catalog history within one request's upstream budget and serves only the requested years", async () => {
    const { hub } = setup();
    await hub.register(range(50).map((index) => `sec-us-h${index}`));
    const first = JSON.parse(await hub.history("2020-01-01")) as { series: Record<string, { rows: Array<[string, string]> }>; pending: string[] };
    const chartCalls = upstream.calls.filter((call) => call.includes("/v8/finance/chart/")).length;
    expect(chartCalls).toBeLessThanOrEqual(36);
    expect(first.pending.length).toBeGreaterThan(0);
    expect(Object.values(first.series).every((item) => item.rows.every(([date]) => date >= "2020-01-01"))).toBe(true);
    const second = JSON.parse(await hub.history("2020-01-01")) as { pending: string[] };
    expect(second.pending).toEqual([]);
    upstream.calls = [];
    await hub.history("2015-01-01");
    expect(upstream.calls).toEqual([]);
  });

  it("reports dividend coverage for every catalog security", async () => {
    const { hub } = setup();
    await hub.register(["sec-us-aapl", "sec-us-msft"]);
    const result = await hub.distributions();
    expect(result.coverage.map((item) => [item.securityId, item.status])).toEqual([["sec-us-aapl", "ready"], ["sec-us-msft", "ready"]]);
    expect(result.distributions.map((event) => event.amountPerUnit)).toEqual(["0.25", "0.25"]);
  });
});
