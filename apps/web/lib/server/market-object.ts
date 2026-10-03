import { MarketHub, serveMarket, type MarketStore } from "./market-hub";
import type { PtsFrame } from "./market-sources";

type SqlCursor = { toArray(): Array<Record<string, unknown>> };
type DurableState = {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
    deleteAll(): Promise<void>;
  };
};

export type MarketNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
};

export type MarketWorkerEnv = {
  MARKET_COORDINATOR?: MarketNamespace;
  /** Legacy public-market D1; read once to seed the catalog. */
  MARKET_DB?: { prepare(query: string): { all<T>(): Promise<{ results?: T[] }> } };
  [name: string]: unknown;
};

/** The single market object. Pinned near the group (eastern North America). */
export function marketStub(env: MarketWorkerEnv) {
  if (!env.MARKET_COORDINATOR) throw new Error("market_object_unbound");
  return env.MARKET_COORDINATOR.get(env.MARKET_COORDINATOR.idFromName("market-v3"), { locationHint: "enam" });
}

const PTS_RETENTION_MINUTES = 3 * 24 * 60;

class SqliteMarketStore implements MarketStore {
  constructor(private sql: DurableState["storage"]["sql"]) {
    sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS pts_frames (minute INTEGER PRIMARY KEY, session_key TEXT NOT NULL, frame TEXT NOT NULL)");
  }
  async get(key: string) {
    return this.sql.exec("SELECT v FROM kv WHERE k = ?", key).toArray()[0]?.v as string | undefined;
  }
  async scan(prefix: string, from = prefix) {
    return this.sql.exec("SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k", from, `${prefix}￿`).toArray()
      .map((row) => [String(row.k), String(row.v)] as [string, string]);
  }
  async put(entries: Array<[string, string]>) {
    for (const [key, value] of entries) this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
  async appendFrame(frame: PtsFrame) {
    this.sql.exec("INSERT OR REPLACE INTO pts_frames (minute, session_key, frame) VALUES (?, ?, ?)", frame.minute, frame.sessionKey, JSON.stringify(frame));
    this.sql.exec("DELETE FROM pts_frames WHERE minute < ?", frame.minute - PTS_RETENTION_MINUTES);
  }
  async frames(sessionKey: string) {
    return this.sql.exec("SELECT frame FROM pts_frames WHERE session_key = ? ORDER BY minute", sessionKey).toArray().map((row) => JSON.parse(String(row.frame)) as PtsFrame);
  }
  async latestFrame() {
    const row = this.sql.exec("SELECT frame FROM pts_frames ORDER BY minute DESC LIMIT 1").toArray()[0];
    return row ? JSON.parse(String(row.frame)) as PtsFrame : undefined;
  }
}

/** Durable Object holding the shared catalog, snapshot, PTS frames and history caches. */
export class MarketCoordinator {
  private hub: MarketHub;

  constructor(private state: DurableState, env: MarketWorkerEnv) {
    const db = env.MARKET_DB;
    this.hub = new MarketHub(new SqliteMarketStore(state.storage.sql), {
      seedCatalog: db ? async () => (await db.prepare("SELECT security_id FROM market_securities WHERE enabled = 1").all<{ security_id: string }>()).results?.map((row) => row.security_id) ?? [] : undefined,
    });
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/tick") {
      await this.hub.tick();
      return new Response(null, { status: 204 });
    }
    // Cloud clients may only add one explicitly selected security at a time.
    return serveMarket(request, this.hub, { maxRegister: 1 });
  }

  /** Only the retired v2 coordinator instance still has alarms; clear its state once. */
  async alarm() {
    await this.state.storage.deleteAll();
  }
}
