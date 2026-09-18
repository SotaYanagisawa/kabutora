import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMarketRequest } from "./server-market-router";
import { currentMarketRequestContext, withMarketRequestContext, type MarketRequestContext } from "./server-market-request-context";
import { getMarketCloudflareContext } from "./cloudflare-market-env";
import * as auth from "./server-auth";
import * as provider from "./server-market-provider";
import * as store from "./server-market-store";

const context: MarketRequestContext = {
  env: { FIREBASE_PROJECT_ID: "test-project", KABUTORA_REQUIRE_AUTH: "true", KABUTORA_REQUIRE_APP_CHECK: "true" },
  ctx: { waitUntil: vi.fn() },
};

afterEach(() => vi.restoreAllMocks());

describe("native market routing", () => {
  it.each([
    ["benchmarks", "GET"], ["distributions", "POST"], ["history", "POST"],
    ["intraday", "GET"], ["quotes", "POST"], ["refresh", "POST"],
    ["registry", "POST"], ["search", "POST"], ["snapshot", "GET"],
  ])("keeps %s authenticated without the Next.js runtime", async (path, method) => {
    const response = await routeMarketRequest(new Request(`https://example.test/api/market/${path}`, { method }), context);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "unauthorized" });
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("leaves application pages to Next and rejects unknown routes and wrong methods", async () => {
    expect(await routeMarketRequest(new Request("https://example.test/"), context)).toBeNull();
    for (const name of ["unknown", "constructor", "__proto__"]) {
      expect((await routeMarketRequest(new Request(`https://example.test/api/market/${name}`), context))?.status).toBe(404);
    }
    const response = await routeMarketRequest(new Request("https://example.test/api/market/quotes"), context);
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("POST");
  });

  it("preserves partial quote responses and invocation bindings", async () => {
    vi.spyOn(auth, "authorizeMarketRequest").mockResolvedValue({ uid: "test" });
    const result: Awaited<ReturnType<typeof provider.fetchMarketQuoteBatch>> = {
      generatedAt: "2026-09-18T14:00:00Z", marketSessions: [], intraday: [],
      quotes: [{ securityId: "sec-us-aapl", symbol: "AAPL", currency: "USD", exchangeMic: "XNAS", price: "200",
        marketTimestamp: "2026-09-18T14:00:00Z", fetchedAt: "2026-09-18T14:00:00Z", freshness: "live",
        provider: "fixture", session: "regular", priceType: "last_trade", venueCode: "US", validationStatus: "valid" }],
      failures: [{ securityId: "sec-us-msft", symbol: "MSFT", message: "unavailable" }],
      coverage: { requested: 2, returned: 1, fresh: 1, stale: 0, suspect: 0 },
    };
    vi.spyOn(provider, "fetchMarketQuoteBatch").mockResolvedValue(result);
    const response = await routeMarketRequest(new Request("https://example.test/api/market/quotes", {
      method: "POST", body: JSON.stringify({ securityIds: "sec-us-aapl,sec-us-msft" }),
    }), context);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject(result);
    expect(currentMarketRequestContext()).toBeUndefined();
  });

  it("preserves snapshot ETags and 304 bodies", async () => {
    vi.spyOn(auth, "authorizeMarketRequest").mockResolvedValue({ uid: "test" });
    const db = {} as NonNullable<MarketRequestContext["env"]["MARKET_DB"]>;
    vi.spyOn(store, "readMarketSnapshot").mockResolvedValue({ savedAt: "now", coverage: { quoted: 1, registered: 1 } } as Awaited<ReturnType<typeof store.readMarketSnapshot>>);
    const localContext = { ...context, env: { ...context.env, MARKET_DB: db } };
    const first = await routeMarketRequest(new Request("https://example.test/api/market/snapshot?intraday=0"), localContext);
    const second = await routeMarketRequest(new Request("https://example.test/api/market/snapshot?intraday=0", { headers: { "If-None-Match": first!.headers.get("ETag")! } }), localContext);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(304);
    expect(await second?.text()).toBe("");
    expect(store.readMarketSnapshot).toHaveBeenCalledWith(db, false);
  });

  it("returns stable JSON instead of exposing server exceptions", async () => {
    vi.spyOn(auth, "authorizeMarketRequest").mockResolvedValue({ uid: "test" });
    vi.spyOn(provider, "fetchMarketQuoteBatch").mockRejectedValue(new Error("private upstream details"));
    const response = await routeMarketRequest(new Request("https://example.test/api/market/quotes", { method: "POST", body: "{}" }), context);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "market_request_unavailable" });
  });

  it("isolates bindings across overlapping requests", async () => {
    const contexts = ["first", "second"].map((id) => ({ ...context, env: { ...context.env, FIREBASE_PROJECT_ID: id } }));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    await Promise.all(contexts.map((value, index) => withMarketRequestContext(value, async () => {
      if (index === 1) release();
      await barrier;
      expect(currentMarketRequestContext()?.env.FIREBASE_PROJECT_ID).toBe(value.env.FIREBASE_PROJECT_ID);
      expect((await getMarketCloudflareContext()).ctx).toBe(value.ctx);
    })));
    expect(currentMarketRequestContext()).toBeUndefined();
  });
});
