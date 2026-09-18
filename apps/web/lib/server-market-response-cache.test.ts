import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./cloudflare-market-env";
import { prepareMarketSnapshotResponses, readPreparedMarketSnapshot } from "./server-market-response-cache";
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
  it("reconciles charts once and serves full/compact responses with a current server clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.generatedAt));
    const read = vi.spyOn(store, "readMarketSnapshot").mockResolvedValue(snapshot);
    const { db } = database();
    await prepareMarketSnapshotResponses(db);
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

  it("falls back when no prepared response exists or its refresh window has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.generatedAt));
    const { db } = database();
    const request = new Request("https://example.test/api/market/snapshot");
    expect(await readPreparedMarketSnapshot(db, request, true)).toBeNull();
    vi.spyOn(store, "readMarketSnapshot").mockResolvedValue(snapshot);
    await prepareMarketSnapshotResponses(db);
    vi.advanceTimersByTime(16 * 60_000);
    expect(await readPreparedMarketSnapshot(db, request, true)).toBeNull();
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
});
