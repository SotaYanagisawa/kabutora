import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./cloudflare-market-env";
import { marketSnapshotEtag, prepareMarketSnapshotResponses, readPreparedMarketSnapshot } from "./server-market-response-cache";
import * as store from "./server-market-store";
import type { ServerMarketSnapshot } from "./server-market-types";

const snapshot: ServerMarketSnapshot = {
  schemaVersion: 1, generatedAt: "2026-09-18T00:00:00.000Z", savedAt: "2026-09-18T00:00:00.000Z", marketSessions: [],
  quotes: [], benchmarks: [], intraday: [{ securityId: "sec-us-aapl", price: "200", timestamp: "2026-09-17T20:00:00.000Z", provider: "fixture" }], intradayRevision: "revision",
  coverage: { registered: 1, quoted: 0, fresh: 0, stale: 0, suspect: 0 },
  refresh: { status: "empty", lastRunAt: null, queueMessagesToday: 1, providerCallsToday: 1 },
};

function database() {
  const rows = new Map<string, { payload_json: string; etag: string; generated_at: string }>();
  class Statement implements D1PreparedStatementLike {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async first<T>() { return (rows.get(String(this.values[0])) ?? null) as T | null; }
    async all<T>() { return { success: true, results: [] as T[] }; }
    async run() { return { success: true }; }
  }
  const db: D1DatabaseLike = {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => statements.map((s) => {
      const [key, payload_json, etag, generated_at] = (s as Statement).values.map(String);
      rows.set(key, { payload_json, etag, generated_at });
      return { success: true };
    }),
  };
  return { db, rows };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("prepared public market responses", () => {
  it("invalidates ETags for benchmark corrections with unchanged quote timestamps", () => {
    const benchmark={id:"usd-jpy",label:"USD/JPY",symbol:"JPY=X",value:145,changeRatio:null,marketTimestamp:snapshot.generatedAt,freshness:"near_live" as const};
    expect(marketSnapshotEtag({...snapshot,benchmarks:[benchmark]},false)).not.toBe(marketSnapshotEtag({...snapshot,benchmarks:[{...benchmark,value:146}]},false));
  });
  it("reconciles charts once and serves full/compact responses with a current server clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.generatedAt));
    const read = vi.spyOn(store, "readMarketSnapshot").mockResolvedValue(snapshot);
    const { db, rows } = database();
    await prepareMarketSnapshotResponses(db);
    expect(rows.get("full")?.payload_json.startsWith("gzip:")).toBe(true);
    vi.setSystemTime(new Date("2026-09-18T00:01:00.000Z"));
    for (const full of [true, false]) {
      const response = await readPreparedMarketSnapshot(db, new Request("https://example.test/api/market/snapshot"), full);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({
        schemaVersion: 1, generatedAt: "2026-09-18T00:01:00.000Z", savedAt: snapshot.savedAt,
        intraday: full ? snapshot.intraday : [],
      });
      const cached = await readPreparedMarketSnapshot(db, new Request("https://example.test/api/market/snapshot", { headers: { "If-None-Match": response!.headers.get("ETag")! } }), full);
      expect(cached?.status).toBe(304);
      expect(await cached?.text()).toBe("");
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("serves existing uncompressed rows during a rolling deployment", async () => {
    const { db, rows } = database();
    rows.set("compact", { payload_json: JSON.stringify({ schemaVersion: 1, quotes: [] }), etag: "legacy", generated_at: new Date().toISOString() });
    const response = await readPreparedMarketSnapshot(db, new Request("https://example.test/api/market/snapshot"), false);
    expect(await response?.json()).toMatchObject({ schemaVersion: 1, quotes: [], marketSessions: expect.any(Array) });
  });

  it("serves the last publication when ingestion is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.generatedAt));
    const { db } = database();
    const request = new Request("https://example.test/api/market/snapshot");
    expect(await readPreparedMarketSnapshot(db, request, true)).toBeNull();
    vi.spyOn(store, "readMarketSnapshot").mockResolvedValue(snapshot);
    await prepareMarketSnapshotResponses(db);
    vi.advanceTimersByTime(16 * 60_000);
    expect((await readPreparedMarketSnapshot(db, request, true))?.headers.get("X-Market-Stale")).toBe("true");
  });

  it("does not load or rewrite price history when persisting dividend-only results", async () => {
    const { db } = database();
    const queries: string[] = [];
    const prepare = db.prepare;
    db.prepare = (sql) => { queries.push(sql); return prepare(sql); };
    await store.upsertHistoryBatch(db, {
      generatedAt: snapshot.generatedAt, requestedFrom: "2000-01-01", marketSessions: [], bars: [], corporateActions: [],
      distributions: [{ id: "dividend", securityId: "sec-us-aapl", amountPerUnit: "1", currency: "USD", exDate: "2026-09-17" } as import("@kabutora/domain").DistributionEvent],
      inceptionDates: { "sec-us-aapl": "1980-12-12" }, failures: [], coverage: { requested: 1, returned: 1 }, coveredSecurityIds: ["sec-us-aapl"],
      quality: { status: "valid", checkedAt: snapshot.generatedAt, acceptedBars: 0, rejectedBars: 0, duplicateBars: 0, suspectMoves: 0, acceptedActions: 0, rejectedActions: 0, checksum: "empty" },
    });
    expect(queries.some((sql) => /(?:FROM|INTO) market_history/u.test(sql))).toBe(false);
    expect(queries.some((sql) => sql.includes("UPDATE market_history SET inception_date"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO market_distributions"))).toBe(true);
  });

  it("skips redundant preparation when recent cache exists within minIntervalMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.generatedAt));
    const read = vi.spyOn(store, "readMarketSnapshot").mockResolvedValue(snapshot);
    const { db } = database();
    const first = await prepareMarketSnapshotResponses(db);
    expect(first).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    // Call 2 minutes later with an 8-minute minIntervalMs threshold -> should skip
    vi.advanceTimersByTime(2 * 60_000);
    const second = await prepareMarketSnapshotResponses(db, { minIntervalMs: 8 * 60_000 });
    expect(second).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    // Call after 8 minutes -> should execute
    vi.advanceTimersByTime(7 * 60_000);
    const third = await prepareMarketSnapshotResponses(db, { minIntervalMs: 8 * 60_000 });
    expect(third).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

