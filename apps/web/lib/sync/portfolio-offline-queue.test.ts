import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingPortfolioEvents,
  enqueuePendingPortfolioEvent,
  flushPendingPortfolioEvents,
  getPendingPortfolioEvents,
  nextMonotonicTimestamp,
  removePendingPortfolioEvent,
  resetPortfolioQueueMemory,
  configurePortfolioQueue,
  portfolioQueueState,
  retryPortfolioQueueStorage,
} from "./portfolio-offline-queue";
import type { EncryptedPortfolioEvent } from "./portfolio-cloud-store";

function createMockIndexedDB() {
  const stores = new Map<string, Map<string, any>>();

  return {
    _stores: stores,
    open: vi.fn((_name: string, _version: number) => {
      const dbInstance = {
        objectStoreNames: {
          contains: (storeName: string) => stores.has(storeName),
        },
        createObjectStore: (storeName: string) => {
          if (!stores.has(storeName)) stores.set(storeName, new Map());
          return {
            createIndex: vi.fn(),
          };
        },
        transaction: (storeName: string) => {
          let storeMap = stores.get(storeName);
          if (!storeMap) {
            storeMap = new Map();
            stores.set(storeName, storeMap);
          }
          const tx: any = {
            objectStore: () => ({
              put: (val: any) => {
                storeMap!.set(val.id, JSON.parse(JSON.stringify(val)));
                return {};
              },
              get: (id: string) => {
                const getReq: any = {
                  result: storeMap!.has(id) ? JSON.parse(JSON.stringify(storeMap!.get(id))) : undefined,
                };
                queueMicrotask(() => getReq.onsuccess?.());
                return getReq;
              },
              getAll: () => {
                const getAllReq: any = {
                  result: Array.from(storeMap!.values()).map((v) => JSON.parse(JSON.stringify(v))),
                };
                queueMicrotask(() => getAllReq.onsuccess?.());
                return getAllReq;
              },
              delete: (id: string) => {
                storeMap!.delete(id);
                return {};
              },
            }),
            oncomplete: null,
            onerror: null,
            onabort: null,
          };
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
        close: vi.fn(),
      };

      const req: any = {
        result: dbInstance,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    }),
  };
}

describe("monotonic timestamps", () => {
  it("generates strictly increasing sequence numbers even under zero-delay loops", () => {
    const count = 100;
    const seqs = new Set<number>();
    let previous = 0;
    for (let i = 0; i < count; i++) {
      const current = nextMonotonicTimestamp();
      expect(current).toBeGreaterThan(previous);
      expect(seqs.has(current)).toBe(false);
      seqs.add(current);
      previous = current;
    }
  });
});

describe("portfolio offline queue", () => {
  let mockIdb: ReturnType<typeof createMockIndexedDB>;

  beforeEach(() => {
    resetPortfolioQueueMemory();
    mockIdb = createMockIndexedDB();
    vi.stubGlobal("indexedDB", mockIdb);
  });

  afterEach(() => {
    resetPortfolioQueueMemory();
    vi.unstubAllGlobals();
  });

  const dummyEvent = (content: string): EncryptedPortfolioEvent => ({
    ownerUid: "user-123",
    payload: {
      algorithm: "AES-256-GCM",
      iv: "dummy-iv",
      ciphertext: content,
    },
  });

  it("retains and flushes an edit when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(enqueuePendingPortfolioEvent("user-123", "volatile", dummyEvent("kept"))).resolves.toEqual({ id: "volatile", durability: "memory" });
    expect(portfolioQueueState("user-123").pending).toBe(1);
    const saved = vi.fn().mockResolvedValue(undefined);
    await expect(flushPendingPortfolioEvents("user-123", saved)).resolves.toEqual({ flushed: 1, remaining: 0 });
    expect(saved).toHaveBeenCalledOnce();
  });

  it("does not access persistent storage on shared devices", async () => {
    configurePortfolioQueue("shared");
    await enqueuePendingPortfolioEvent("user-123", "shared", dummyEvent("kept"));
    expect(await getPendingPortfolioEvents("user-123")).toHaveLength(1);
    expect(await getPendingPortfolioEvents("other-user")).toHaveLength(0);
    await flushPendingPortfolioEvents("user-123", async () => undefined);
    expect(mockIdb.open).not.toHaveBeenCalled();
  });
  it("recovers persistent storage on explicit retry while retaining an edit from memory", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await enqueuePendingPortfolioEvent("user-123", "recover-storage", dummyEvent("encrypted edit"));
    expect(portfolioQueueState("user-123").memoryOnly).toBe(1);
    vi.stubGlobal("indexedDB", mockIdb);
    await retryPortfolioQueueStorage("user-123");
    expect(portfolioQueueState("user-123")).toEqual({ pending: 1, memoryOnly: 0, storageUnavailable: false });
    resetPortfolioQueueMemory();
    expect((await getPendingPortfolioEvents("user-123"))[0].event.payload.ciphertext).toBe("encrypted edit");
  });

  it("enqueues, retrieves in monotonic order, and removes items", async () => {
    await enqueuePendingPortfolioEvent("user-123", "evt-1", dummyEvent("first"));
    await enqueuePendingPortfolioEvent("user-123", "evt-2", dummyEvent("second"));
    await enqueuePendingPortfolioEvent("user-456", "evt-other", { ...dummyEvent("other"), ownerUid: "user-456" });

    const userEvents = await getPendingPortfolioEvents("user-123");
    expect(userEvents).toHaveLength(2);
    expect(userEvents[0]?.id).toBe("evt-1");
    expect(userEvents[1]?.id).toBe("evt-2");
    expect(userEvents[0]!.monotonicSeq).toBeLessThan(userEvents[1]!.monotonicSeq);

    await removePendingPortfolioEvent("user-123", "evt-1");
    const afterRemoval = await getPendingPortfolioEvents("user-123");
    expect(afterRemoval).toHaveLength(1);
    expect(afterRemoval[0]?.id).toBe("evt-2");
  });

  it("clears all pending items for a user", async () => {
    await enqueuePendingPortfolioEvent("user-123", "evt-1", dummyEvent("a"));
    await enqueuePendingPortfolioEvent("user-123", "evt-2", dummyEvent("b"));
    await enqueuePendingPortfolioEvent("user-456", "evt-3", { ...dummyEvent("c"), ownerUid: "user-456" });

    await clearPendingPortfolioEvents("user-123");
    expect(await getPendingPortfolioEvents("user-123")).toEqual([]);
    expect(await getPendingPortfolioEvents("user-456")).toHaveLength(1);
  });

  it("flushes pending events in order and clears them on success", async () => {
    await enqueuePendingPortfolioEvent("user-123", "evt-1", dummyEvent("first"));
    await enqueuePendingPortfolioEvent("user-123", "evt-2", dummyEvent("second"));

    const saved: string[] = [];
    const result = await flushPendingPortfolioEvents("user-123", async (_uid, eventId, event) => {
      saved.push(`${eventId}:${event.payload.ciphertext}`);
    });

    expect(result.flushed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(saved).toEqual(["evt-1:first", "evt-2:second"]);
    expect(await getPendingPortfolioEvents("user-123")).toEqual([]);
  });

  it("halts flushing upon network error and preserves remaining events in queue", async () => {
    await enqueuePendingPortfolioEvent("user-123", "evt-1", dummyEvent("first"));
    await enqueuePendingPortfolioEvent("user-123", "evt-2", dummyEvent("second"));
    await enqueuePendingPortfolioEvent("user-123", "evt-3", dummyEvent("third"));

    let attempt = 0;
    const result = await flushPendingPortfolioEvents("user-123", async (_uid, eventId) => {
      attempt++;
      if (eventId === "evt-2") {
        throw new Error("network_offline");
      }
    });

    expect(attempt).toBe(2);
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(2);

    const remaining = await getPendingPortfolioEvents("user-123");
    expect(remaining.map((r) => r.id)).toEqual(["evt-2", "evt-3"]);
    expect(remaining[0]?.retryCount).toBe(1);
  });
  it("keeps one flush per account and preserves retry ordering across account switching", async () => {
    await enqueuePendingPortfolioEvent("user-123", "retry-first", dummyEvent("first"));
    await enqueuePendingPortfolioEvent("user-123", "retry-second", dummyEvent("second"));
    await enqueuePendingPortfolioEvent("user-456", "other-account", { ...dummyEvent("other"), ownerUid: "user-456" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = flushPendingPortfolioEvents("user-123", async (_uid, id) => { order.push(id); await gate; });
    const same = flushPendingPortfolioEvents("user-123", async () => { throw new Error("must not start a second flush"); });
    expect(first).toBe(same);
    await flushPendingPortfolioEvents("user-456", async (uid, id) => { expect(uid).toBe("user-456"); order.push(id); });
    release(); await first;
    expect(order.filter((id) => id.startsWith("retry"))).toEqual(["retry-first", "retry-second"]);
    expect(await getPendingPortfolioEvents("user-123")).toEqual([]);
    expect(await getPendingPortfolioEvents("user-456")).toEqual([]);
  });
  it("reloads encrypted pending edits and retries an acknowledged duplicate idempotently", async () => {
    await enqueuePendingPortfolioEvent("user-123", "durable", dummyEvent("ciphertext-only"));
    resetPortfolioQueueMemory();
    expect((await getPendingPortfolioEvents("user-123"))[0].event.payload.ciphertext).toBe("ciphertext-only");
    const confirmed = new Set<string>();
    let first = true;
    const save = async (_uid: string, id: string) => { confirmed.add(id); if (first) { first = false; throw new Error("response lost after commit"); } };
    await flushPendingPortfolioEvents("user-123", save);
    expect(await getPendingPortfolioEvents("user-123")).toHaveLength(1);
    await flushPendingPortfolioEvents("user-123", save, true);
    expect(confirmed.size).toBe(1);
    expect(await getPendingPortfolioEvents("user-123")).toEqual([]);
  });
});
