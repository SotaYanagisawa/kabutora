import { MarketCoordinator as ProductionCoordinator, marketStub, type MarketWorkerEnv } from "../lib/server/market-object";
import { routeMarketRequest } from "../lib/server/market-router";
import { createFakeUpstream, weekdays } from "./fake-upstream";

/**
 * Local-only harness for `pnpm test:worker`: the production router and Durable Object in workerd,
 * with upstream providers replaced by a fake that adds real latency. worker-entry.ts never imports it.
 */
const days = weekdays("2025-01-06", new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
const upstream = createFakeUpstream({
  now: () => Date.now(),
  latencyMs: 80,
  securities: {
    "7203.T": { currency: "JPY", zone: "Asia/Tokyo", closes: days.map((date) => [date, 3_000]), price: 3_050, previousClose: 3_000, name: "TOYOTA MOTOR CORP" },
    "285A.T": { currency: "JPY", zone: "Asia/Tokyo", closes: days.map((date) => [date, date < "2026-09-29" ? 17_000 : 18_000]), splits: [["2026-09-29", 3, 1]], dividends: [["2026-03-30", 15]], price: 18_735, previousClose: 19_120 },
    "AAPL": { currency: "USD", zone: "America/New_York", closes: days.map((date) => [date, 250]), price: 255, previousClose: 250 },
    "JPY=X": { currency: "JPY", zone: "Asia/Tokyo", closes: days.map((date) => [date, 150]), price: 151, previousClose: 150 },
    "^N225": { currency: "JPY", zone: "Asia/Tokyo", closes: [], price: 70_000, previousClose: 69_000 },
  },
  pts: { "7203": 3_060 },
});
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return upstream.hosts.has(url.hostname) ? upstream.fetch(input, init) : realFetch(input, init);
};

export class MarketCoordinator extends ProductionCoordinator {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== "/__upstream") return super.fetch(request);
    if (url.searchParams.has("fail")) upstream.state.fail = url.searchParams.get("fail") === "1";
    const calls = upstream.state.calls;
    const paths = Object.fromEntries(upstream.state.byPath);
    if (url.searchParams.has("reset")) {
      upstream.state.calls = 0;
      upstream.state.byPath.clear();
    }
    return Response.json({ calls, paths });
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
