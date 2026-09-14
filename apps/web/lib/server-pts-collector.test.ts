import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "./cloudflare-market-env";
import { collectJapannextPts } from "./server-pts-collector";

class Statement implements D1PreparedStatementLike {
  values: unknown[] = [];
  constructor(readonly query: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async all<T>() {
    if (this.query.includes("FROM market_securities")) {
      return { success: true, results: [
        { security_id: "sec-7203", provider_symbol: "7203.T" },
        { security_id: "sec-us-aapl", provider_symbol: "AAPL" },
      ] as T[] };
    }
    return { success: true, results: [] as T[] };
  }
  async first<T>() { return null as T | null; }
  async run(): Promise<D1ResultLike> { return { success: true }; }
}

describe("Japannext PTS collector", () => {
  it("stores one packed minute frame for all selected rows", async () => {
    const batches: Statement[][] = [];
    const db: D1DatabaseLike = {
      prepare: (query) => new Statement(query),
      batch: async (statements) => {
        batches.push(statements as Statement[]);
        return statements.map(() => ({ success: true }));
      },
    };
    const scheduledTime = Date.parse("2026-09-10T23:20:00.000Z");
    const fetchImpl = vi.fn(async () => new Response(
      'mdata[ 1 ] = [ "7203", "", "", "", "2972.0", "3017.2", "2950.0", "3009.1", "278800.0" ];',
      { status: 200, headers: { "Last-Modified": new Date(scheduledTime).toUTCString(), ETag: '"sample"' } },
    ));

    await expect(collectJapannextPts(db, scheduledTime, fetchImpl as typeof fetch)).resolves.toEqual({
      status: "stored",
      symbols: 1,
      observedMinute: "2026-09-10T23:20:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0][0].values).toEqual(expect.arrayContaining([
      "2026-09-11",
      "JNX_DAY",
      "2026-09-10T23:20:00.000Z",
      JSON.stringify({ "7203": ["3009.1", "278800.0"] }),
    ]));
  });
});
