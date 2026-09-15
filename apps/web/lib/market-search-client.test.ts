import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./firebase-client", () => ({
  getMarketAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));

describe("market search client", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("reuses normalized query results without another API request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: "sec-aapl" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onNetworkRequest = vi.fn();
    const { searchMarketSecurities } = await import("./market-search-client");

    await expect(searchMarketSecurities<{ id: string }>(" AAPL ", onNetworkRequest)).resolves.toEqual([{ id: "sec-aapl" }]);
    await expect(searchMarketSecurities<{ id: string }>("aapl", onNetworkRequest)).resolves.toEqual([{ id: "sec-aapl" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onNetworkRequest).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous searches for the same query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: "sec-7203" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { searchMarketSecurities } = await import("./market-search-client");

    await Promise.all([
      searchMarketSecurities("7203"),
      searchMarketSecurities("7203"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes cancellation to an interactive search request", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const { searchMarketSecurities } = await import("./market-search-client");
    const task = searchMarketSecurities("cancel-me", { signal: controller.signal });
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
