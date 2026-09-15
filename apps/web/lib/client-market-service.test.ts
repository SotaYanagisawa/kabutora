import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearInMemorySnapshotCache, loadServerMarketSnapshot } from "./client-market-service";
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
  beforeEach(() => {
    clearInMemorySnapshotCache();
    vi.restoreAllMocks();
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
