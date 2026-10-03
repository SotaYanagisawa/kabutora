import { describe, expect, it } from "vitest";
import { MarketHub, MemoryMarketStore } from "./market-hub";

/**
 * Upstream canary against the real providers. Opt-in (`pnpm check:live`) because it
 * needs the network; it catches provider schema drift and measures real latency.
 */
const live = process.env.KABUTORA_LIVE === "1";
const CATALOG = [
  "sec-7203", "sec-9984", "sec-6758", "sec-8306", "sec-1306", "sec-285a",
  "sec-us-aapl", "sec-us-msft", "sec-us-nvda", "sec-us-voo", "sec-us-qqq",
  "sec-jp-fund-0331418a", // eMAXIS Slim 全世界株式
];

describe.runIf(live)("live market providers", () => {
  it("prices a mixed catalog in one refresh and serves the warm snapshot instantly", async () => {
    let offset = 0;
    const hub = new MarketHub(new MemoryMarketStore(), { now: () => Date.now() + offset });
    expect((await hub.register(CATALOG)).rejected).toEqual([]);

    const coldStart = performance.now();
    const cold = await hub.snapshot();
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    await hub.snapshot();
    const warmMs = performance.now() - warmStart;
    // The common case: a warm object whose 15-second snapshot has expired.
    offset = 20_000;
    const refreshStart = performance.now();
    await hub.snapshot();
    const refreshMs = performance.now() - refreshStart;

    const quotes = new Map(cold.snapshot.quotes.map((quote) => [quote.securityId, quote]));
    console.info(JSON.stringify({ coldMs: Math.round(coldMs), refreshMs: Math.round(refreshMs), warmMs: Number(warmMs.toFixed(2)), quotes: quotes.size, series: cold.snapshot.series.length, bytes: cold.body.length, failures: cold.snapshot.failures }));
    for (const id of [...CATALOG, "sec-fx-usdjpy"]) {
      const quote = quotes.get(id);
      expect(quote, id).toBeDefined();
      expect(Number(quote!.price), id).toBeGreaterThan(0);
      expect(Date.now() - Date.parse(quote!.marketTimestamp), id).toBeLessThan(10 * 86_400_000);
    }
    expect(cold.snapshot.benchmarks.map((benchmark) => benchmark.id).sort()).toEqual(["cny-jpy", "dow", "nasdaq", "nikkei225", "sp500", "topix", "usd-jpy"]);
    expect(cold.snapshot.series.find((item) => item.id === "sec-us-aapl")?.t.length).toBeGreaterThan(50);
    expect(coldMs).toBeLessThan(5_000);
    expect(refreshMs).toBeLessThan(1_500);
    expect(warmMs).toBeLessThan(5);
  }, 30_000);

  it("returns catalog history and dividend coverage", async () => {
    const hub = new MarketHub(new MemoryMarketStore());
    await hub.register(["sec-us-aapl", "sec-7203", "sec-jp-fund-0331418a"]);
    const history = JSON.parse(await hub.history("2024-01-01")) as { series: Record<string, { rows: unknown[] }>; pending: string[] };
    expect(history.pending).toEqual([]);
    expect(history.series["sec-us-aapl"].rows.length).toBeGreaterThan(400);
    expect(history.series["sec-7203"].rows.length).toBeGreaterThan(400);
    const distributions = await hub.distributions();
    expect(distributions.coverage.map((item) => item.securityId).sort()).toEqual(["sec-7203", "sec-jp-fund-0331418a", "sec-us-aapl"]);
    expect(distributions.distributions.some((event) => event.securityId === "sec-us-aapl")).toBe(true);
  }, 60_000);
});
