import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearInMemorySnapshotCache, loadServerMarketSnapshot, loadStartupMarketSnapshots, refreshQueuedMarketData } from "./client-market-service";
import * as clientMarketCache from "./client-market-cache";
import type { ServerMarketSnapshot } from "./server-market-types";

vi.mock("./firebase-client", () => ({
  getMarketAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));

const mockSnapshot: ServerMarketSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-04T00:00:00.000Z",
  savedAt: "2026-09-04T00:00:00.000Z",
  marketSessions: [],
  quotes: [
    {
      securityId: "sec-jp-7203",
      symbol: "7203",
      exchangeMic: "XTKS",
      currency: "JPY",
      price: "2500",
      marketTimestamp: "2026-09-04T00:00:00.000Z",
      fetchedAt: "2026-09-04T00:00:00.000Z",
      freshness: "near_live",
      provider: "mock",
      session: "regular",
      priceType: "last_trade",
      venueCode: "TSE",
      validationStatus: "valid",
    },
  ],
  benchmarks: [],
  intraday: [],
  coverage: {
    registered: 1,
    quoted: 1,
    fresh: 1,
    stale: 0,
    suspect: 0,
  },
  refresh: {
    status: "ready",
    lastRunAt: null,
    queueMessagesToday: 0,
    providerCallsToday: 0,
  },
};

describe("client-market-service", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    clearInMemorySnapshotCache();
    vi.restoreAllMocks();
  });

  it("paints saved charts and fresh prices while the full network snapshot is still pending", async () => {
    const cached = { ...mockSnapshot, intraday: [{ securityId: "sec-jp-7203", timestamp: new Date().toISOString(), price: "2500", provider: "mock" }] };
    vi.spyOn(clientMarketCache, "readServerSnapshotCache").mockImplementation(async (mode) => mode === "full" ? { snapshot: cached, etag: "saved", savedAt: cached.savedAt! } : null);
    vi.spyOn(clientMarketCache, "writeServerSnapshotCache").mockResolvedValue(true);
    let finishCompact!: (response: Response) => void;
    let finishFull!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve) => {
      if (url.includes("intraday=0")) finishCompact = resolve;
      else finishFull = resolve;
    })));
    const onSnapshot = vi.fn();
    const task = loadStartupMarketSnapshots({ allowPersistentCache: true, onSnapshot });
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ quotes: cached.quotes, intraday: cached.intraday, generatedAt: "", marketSessions: [], refresh: expect.objectContaining({ status: "partial" }) })));
    await vi.waitFor(() => expect(finishCompact).toBeTypeOf("function"));
    const fresh = { ...mockSnapshot, quotes: mockSnapshot.quotes.map((quote) => ({ ...quote, price: "2700", fetchedAt: "2026-09-04T00:01:00.000Z" })) };
    finishCompact(Response.json(fresh));
    await vi.waitFor(() => expect(onSnapshot.mock.lastCall?.[0].quotes[0].price).toBe("2700"));
    expect(onSnapshot.mock.lastCall?.[0].intraday).toEqual(cached.intraday);
    finishFull(Response.json(cached));
    await task;
    expect(onSnapshot.mock.lastCall?.[0].quotes[0].price).toBe("2700");
  });

  it("starts prices without waiting for storage, then restores late charts without reverting prices", async () => {
    let finishCache!: (value: clientMarketCache.PersistedServerSnapshot | null) => void;
    vi.spyOn(clientMarketCache, "readServerSnapshotCache").mockImplementation(() => new Promise((resolve) => { finishCache = resolve; }));
    const fresh = { ...mockSnapshot, quotes: mockSnapshot.quotes.map((quote) => ({ ...quote, price: "2700", fetchedAt: "2026-09-04T00:01:00.000Z" })) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(fresh)));
    const onSnapshot = vi.fn();
    vi.spyOn(clientMarketCache, "writeServerSnapshotCache").mockResolvedValue(true);
    const task = loadStartupMarketSnapshots({ allowPersistentCache: true, onSnapshot });
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled());
    const intraday = [{ securityId: "sec-jp-7203", timestamp: new Date().toISOString(), price: "2500", provider: "mock" }];
    finishCache({ snapshot: { ...mockSnapshot, intraday }, etag: "late", savedAt: mockSnapshot.savedAt! });
    await task;
    expect(onSnapshot.mock.calls.every(([snapshot]) => snapshot.quotes[0].price === "2700")).toBe(true);
    expect(onSnapshot.mock.lastCall?.[0].intraday).toEqual(intraday);
  });

  it("never opens persistent snapshots on shared devices", async () => {
    const read = vi.spyOn(clientMarketCache, "readServerSnapshotCache");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(mockSnapshot)));
    await loadStartupMarketSnapshots({ allowPersistentCache: false, onSnapshot: vi.fn() });
    expect(read).not.toHaveBeenCalled();
  });

  it("manual refresh queues provider work and polls until each requested quote has been fetched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T15:00:00Z"));
    const fresh = { ...mockSnapshot, quotes: mockSnapshot.quotes.map((q) => ({ ...q, fetchedAt: new Date().toISOString() })) };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ queued: 1 }))
      .mockResolvedValueOnce(Response.json(mockSnapshot))
      .mockResolvedValueOnce(Response.json(fresh));
    vi.stubGlobal("fetch", fetch);
    const onSnapshot = vi.fn();
    const result = refreshQueuedMarketData(["sec-jp-7203"], { allowPersistentCache: false, onSnapshot });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe("updated");
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/market/refresh", "/api/market/snapshot?intraday=0", "/api/market/snapshot?intraday=0",
    ]);
  });

  it("reports the free allowance limit without starting direct provider requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ queued: 0, budgetLimited: true }, { status: 429 }))
      .mockResolvedValueOnce(Response.json(mockSnapshot));
    vi.stubGlobal("fetch", fetch);
    expect(await refreshQueuedMarketData(["sec-jp-7203"], { allowPersistentCache: false, onSnapshot: vi.fn() })).toBe("limited");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not report stale prices as a completed refresh when queue work is delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T15:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ queued: 1 }))
      .mockImplementation(async () => Response.json(mockSnapshot)));
    const result = refreshQueuedMarketData(["sec-jp-7203"], { allowPersistentCache: false, onSnapshot: vi.fn() });
    await vi.advanceTimersByTimeAsync(32_000);
    expect(await result).toBe("pending");
  });

  it("defaults to compact mode (?intraday=0) on the critical path", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), {
        status: 200,
        headers: { ETag: 'W/"etag-compact-1"' },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const snapshot = await loadServerMarketSnapshot();
    expect(snapshot).toEqual(mockSnapshot);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/market/snapshot?intraday=0"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("requests full mode without ?intraday=0 when includeIntraday: true", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), {
        status: 200,
        headers: { ETag: 'W/"etag-full-1"' },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const snapshot = await loadServerMarketSnapshot({ includeIntraday: true });
    expect(snapshot).toEqual(mockSnapshot);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/market\/snapshot$/),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("attaches If-None-Match and handles HTTP 304 by returning cached snapshot", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async (_url, options) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(mockSnapshot), {
          status: 200,
          headers: { ETag: 'W/"etag-compact-123"' },
        });
      }
      expect(options.headers["If-None-Match"]).toBe('W/"etag-compact-123"');
      return new Response(null, {
        status: 304,
        headers: { ETag: 'W/"etag-compact-123"' },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const first = await loadServerMarketSnapshot();
    expect(first).toEqual(mockSnapshot);

    const second = await loadServerMarketSnapshot();
    expect(second).toEqual(mockSnapshot);
    expect(callCount).toBe(2);
  });

  it("hydrates ETag and snapshot from IndexedDB on cold boot and returns 304 result", async () => {
    vi.spyOn(clientMarketCache, "readServerSnapshotCache").mockResolvedValue({
      etag: 'W/"etag-cold-boot"',
      snapshot: mockSnapshot,
      savedAt: "2026-09-04T00:00:00.000Z",
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { ETag: 'W/"etag-cold-boot"' },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const snapshot = await loadServerMarketSnapshot();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/market/snapshot?intraday=0"),
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": 'W/"etag-cold-boot"' }),
      }),
    );
    expect(snapshot).toEqual(mockSnapshot);
  });

  it("persists ETag and snapshot to IndexedDB when server returns 200", async () => {
    const writeSpy = vi.spyOn(clientMarketCache, "writeServerSnapshotCache").mockResolvedValue(true);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), {
        status: 200,
        headers: { ETag: 'W/"etag-persisted"' },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadServerMarketSnapshot();
    expect(writeSpy).toHaveBeenCalledWith("compact", mockSnapshot, 'W/"etag-persisted"');
  });

  it("skips persistent storage when allowPersistentCache: false", async () => {
    const writeSpy = vi.spyOn(clientMarketCache, "writeServerSnapshotCache").mockResolvedValue(true);
    const readSpy = vi.spyOn(clientMarketCache, "readServerSnapshotCache").mockResolvedValue(null);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), {
        status: 200,
        headers: { ETag: 'W/"etag-private"' },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadServerMarketSnapshot({ allowPersistentCache: false });
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
