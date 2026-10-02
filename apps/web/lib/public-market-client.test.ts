import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearPublicMarketCache, fetchMarketResponse, loadPublicMarketResource } from "./public-market-client";
vi.mock("./firebase-config", () => ({ firebaseConfigured: true }));
vi.mock("./firebase-client", () => ({ getMarketAuthHeaders: async () => ({ Authorization: "Bearer synthetic" }) }));
beforeEach(() => { clearPublicMarketCache(); vi.stubEnv("NEXT_PUBLIC_KABUTORA_MARKET_BACKEND", "v2"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const revision = "a".repeat(64);
it("rejects corrupt transport chunks and bounds response bytes before decoding", async () => {
    const corrupt = vi.fn().mockResolvedValueOnce(Response.json({ resource: "quotes", revision, chunk_count: 1, published_at: "2026-10-01T00:00:00Z", chunk_keys: ["f".repeat(64)] })).mockResolvedValueOnce(Response.json({ quotes: [] }));
    vi.stubGlobal("fetch", corrupt);
    await expect(loadPublicMarketResource("quotes")).rejects.toThrow("market_chunk_checksum_mismatch");
    clearPublicMarketCache();
    const large = vi.fn().mockResolvedValueOnce(Response.json({ resource: "quotes", revision: "b".repeat(64), chunk_count: 1, published_at: "2026-10-01T00:00:00Z" })).mockResolvedValueOnce(new Response("あ".repeat(81000)));
    vi.stubGlobal("fetch", large);
    await expect(loadPublicMarketResource("quotes")).rejects.toThrow("market_chunk_too_large");
});
it("downloads identical group-wide chunks for different private symbol selections", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ resource: "history", revision, chunk_count: 1, published_at: "2026-10-01T00:00:00Z" })).mockResolvedValueOnce(Response.json({ bars: [{ securityId: "sec-us-aapl", date: "2026-01-01", close: "100" }, { securityId: "sec-us-msft", date: "2026-01-01", close: "200" }], corporateActions: [], inceptionDates: {} }));
    vi.stubGlobal("fetch", request);
    const apple = await fetchMarketResponse("/api/market/history", { method: "POST", body: JSON.stringify({ securityIds: "sec-us-aapl", from: "2026-01-05" }) });
    const microsoft = await fetchMarketResponse("/api/market/history", { method: "POST", body: JSON.stringify({ securityIds: "sec-us-msft", from: "2026-02-09" }) });
    expect((await apple.json()).bars[0].securityId).toBe("sec-us-aapl");
    expect((await microsoft.json()).bars[0].securityId).toBe("sec-us-msft");
    expect(request).toHaveBeenCalledTimes(2);
    for (const [url, init] of request.mock.calls) {
        expect(String(url)).not.toMatch(/aapl|msft|2026-01-05|2026-02-09/);
        expect(init.body).toBeUndefined();
    }
});
it("coalesces concurrent loads and rejects malformed manifests before downloading chunks", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ resource: "history", revision, chunk_count: 100000, published_at: "2026-10-01T00:00:00Z" }));
    vi.stubGlobal("fetch", request);
    const results = await Promise.allSettled([loadPublicMarketResource("history"), loadPublicMarketResource("history")]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
});
it("decodes packed history and preserves inception metadata across public chunks", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ resource: "history", revision, chunk_count: 2, published_at: "2026-10-01T00:00:00Z" }))
        .mockResolvedValueOnce(Response.json({ historyBlocks: [{ securityId: "sec-us-aapl", provider: "fixture", rows: [["2026-01-01", "100.1234567890123456789"]] }], inceptionDates: { "sec-us-aapl": "1980-12-12" }, corporateActions: [] }))
        .mockResolvedValueOnce(Response.json({ historyBlocks: [{ securityId: "sec-us-msft", provider: "fixture", rows: [["2026-01-01", "200", "199.5"]] }], inceptionDates: { "sec-us-msft": "1986-03-13" }, corporateActions: [] }));
    vi.stubGlobal("fetch", request);
    const all = await loadPublicMarketResource("history");
    expect(all.bars).toEqual([{ securityId: "sec-us-aapl", provider: "fixture", date: "2026-01-01", close: "100.1234567890123456789" }, { securityId: "sec-us-msft", provider: "fixture", date: "2026-01-01", close: "200", adjustedClose: "199.5" }]);
    expect(all.inceptionDates).toEqual({ "sec-us-aapl": "1980-12-12", "sec-us-msft": "1986-03-13" });
});
it("keeps PTS responses separate from regular intraday observations", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ resource: "intraday", revision, chunk_count: 1, published_at: "2026-10-01T00:00:00Z" })).mockResolvedValueOnce(Response.json({ bars: [{ securityId: "sec-7203", timestamp: "2026-10-01T01:00:00Z", price: "100", provider: "fixture", session: "regular" }, { securityId: "sec-7203", timestamp: "2026-10-01T08:00:00Z", price: "101", provider: "japannext_pts_public", session: "pts_night" }] }));
    vi.stubGlobal("fetch", request);
    const payload = await (await fetchMarketResponse("/api/market/intraday?securityIds=sec-7203")).json();
    expect(payload.bars).toHaveLength(1);
    expect(payload.bars[0].session).toBe("pts_night");
});
it("traverses 1,512,000 common history points while expanding only the local selection", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
        requests.push(input);
        const url = new URL(input, "https://synthetic.test");
        if (!url.searchParams.has("chunk"))
            return Response.json({ resource: "history", revision, chunk_count: 200, published_at: "2026-10-01T00:00:00Z" });
        const index = Number(url.searchParams.get("chunk")), securityId = `sec-us-fixture-${index}`;
        const historyBlocks = Array.from({ length: 15 }, (_, block) => ({ securityId, provider: "synthetic", rows: Array.from({ length: block === 14 ? 392 : 512 }, () => ["2026-01-01", "100.125"]) }));
        return Response.json({ historyBlocks, corporateActions: [], inceptionDates: { [securityId]: "1997-01-01" } });
    });
    const payload = await loadPublicMarketResource("history", new Set(["sec-us-fixture-123"]));
    expect(payload.bars).toHaveLength(7560);
    expect((payload.bars as Array<{
        securityId: string;
    }>).every(bar => bar.securityId === "sec-us-fixture-123")).toBe(true);
    expect(payload.inceptionDates).toEqual({ "sec-us-fixture-123": "1997-01-01" });
    expect(requests).toHaveLength(201);
    expect(requests.every(url => !url.includes("fixture-123"))).toBe(true);
}, 20000);
