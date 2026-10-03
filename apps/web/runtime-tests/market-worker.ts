import { MarketCoordinator as ProductionCoordinator, marketStub, type MarketWorkerEnv } from "../lib/server/market-object";
import { routeMarketRequest } from "../lib/server/market-router";

/**
 * Local-only harness for `pnpm test:worker`: the production router and Durable Object
 * in workerd, with upstream providers replaced by a fake that adds real latency.
 * Production worker-entry.ts never imports this module.
 */
const upstream = { calls: 0, fail: false, latencyMs: 80 };
const HOSTS = new Set(["query1.finance.yahoo.com", "query2.finance.yahoo.com", "finance.yahoo.co.jp", "www.japannext.co.jp"]);
const realFetch = globalThis.fetch.bind(globalThis);

function spark(symbols: string[], days: number) {
  const now = Math.floor(Date.now() / 1000);
  const step = days === 1 ? 300 : 900;
  const count = days === 1 ? 78 : 130;
  return {
    spark: {
      result: symbols.map((symbol) => {
        const timestamp = Array.from({ length: count }, (_, index) => now - 60 - (count - 1 - index) * step);
        return {
          symbol,
          response: [{
            meta: { regularMarketPrice: 100.125, regularMarketTime: now - 60, previousClose: 99, shortName: symbol, currentTradingPeriod: { regular: { start: now - 20_000, end: now + 3_600 } } },
            timestamp,
            indicators: { quote: [{ close: timestamp.map((_, index) => 100 + (index % 5) / 8) }] },
          }],
        };
      }),
    },
  };
}

function chart() {
  const start = Date.UTC(2018, 0, 2) / 1000;
  const timestamp = Array.from({ length: 100 }, (_, index) => start + index * 30 * 86_400);
  return { chart: { result: [{ meta: { currency: "USD", firstTradeDate: start }, timestamp, indicators: { quote: [{ close: timestamp.map(() => 100) }], adjclose: [{ adjclose: timestamp.map(() => 99) }] }, events: {} }] } };
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!HOSTS.has(url.hostname)) return realFetch(input, init);
  upstream.calls += 1;
  await new Promise((resolve) => setTimeout(resolve, upstream.latencyMs));
  if (upstream.fail) throw new Error("synthetic_upstream_outage");
  if (url.pathname === "/v7/finance/spark") return Response.json(spark(url.searchParams.get("symbols")!.split(","), url.searchParams.get("range") === "5d" ? 5 : 1));
  if (url.pathname.startsWith("/v8/finance/chart/")) return Response.json(chart());
  if (url.hostname === "finance.yahoo.co.jp") return new Response('"mainDomesticIndexPriceBoard":{"price":"3,000.5","changePriceRate":"+0.10","japanUpdateTime":"15:30"}');
  return new Response('mdata[ 1 ] = [ "7203", "", "", "", "100", "101", "99", "100.5", "10.0" ];', { headers: { "Last-Modified": new Date(Date.now() - 30_000).toUTCString() } });
};

export class MarketCoordinator extends ProductionCoordinator {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== "/__upstream") return super.fetch(request);
    if (url.searchParams.has("fail")) upstream.fail = url.searchParams.get("fail") === "1";
    const calls = upstream.calls;
    if (url.searchParams.has("reset")) upstream.calls = 0;
    return Response.json({ calls });
  }
}

export default {
  async fetch(request: Request, env: MarketWorkerEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/__health") return new Response("local-runtime");
    if (url.pathname === "/__upstream") return marketStub(env).fetch(`https://market/__upstream${url.search}`);
    if (url.pathname === "/__tick") return marketStub(env).fetch("https://market/tick", { method: "POST" });
    // Authenticated data paths, reached here without Firebase tokens.
    if (url.pathname.startsWith("/__market/")) return marketStub(env).fetch(new Request(`https://kabutora.test/api/market/${url.pathname.slice(10)}${url.search}`, request));
    return await routeMarketRequest(request, env) ?? new Response("not found", { status: 404 });
  },
};
