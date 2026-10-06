import { MarketService, serveMarket, type MarketStore } from "./market-service";

type SqlCursor = { toArray(): Array<Record<string, unknown>> };
type DurableState = {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
};

export type MarketNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
};

export type MarketWorkerEnv = {
  MARKET_COORDINATOR?: MarketNamespace;
  /** Legacy public-market D1; read once to seed an empty catalog. */
  MARKET_DB?: { prepare(query: string): { all<T>(): Promise<{ results?: T[] }> } };
  [name: string]: unknown;
};

/** The single market object (same instance and catalog as before). */
export function marketStub(env: MarketWorkerEnv) {
  if (!env.MARKET_COORDINATOR) throw new Error("market_object_unbound");
  return env.MARKET_COORDINATOR.get(env.MARKET_COORDINATOR.idFromName("market-v3"), { locationHint: "enam" });
}

const SCHEMA = "4";

class SqliteMarketStore implements MarketStore {
  constructor(private sql: DurableState["storage"]["sql"]) {
    sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    if (sql.exec("SELECT v FROM kv WHERE k = 'schema'").toArray()[0]?.v !== SCHEMA) {
      // Caches written by the previous market backend; the catalog is kept.
      sql.exec("DELETE FROM kv WHERE k = 'snapshot' OR k LIKE 'hist:%' OR k LIKE 'hmeta:%' OR k LIKE 'dist:%'");
      sql.exec("DROP TABLE IF EXISTS pts_frames");
      sql.exec("INSERT INTO kv (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", SCHEMA);
    }
  }
  hasCatalog() {
    return this.sql.exec("SELECT 1 FROM kv WHERE k = 'catalog'").toArray().length > 0;
  }
  async get(key: string) {
    return this.sql.exec("SELECT v FROM kv WHERE k = ?", key).toArray()[0]?.v as string | undefined;
  }
  async put(entries: Array<[string, string]>) {
    for (const [key, value] of entries) this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
  async scan(prefix: string) {
    return this.sql.exec("SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k", prefix, `${prefix}￿`).toArray()
      .map((row) => [String(row.k), String(row.v)] as [string, string]);
  }
}

/** Durable Object holding the catalog, quotes, intraday series, PTS points and daily-history records. */
export class MarketCoordinator {
  private store: SqliteMarketStore;
  private service: MarketService;

  constructor(private state: DurableState, env: MarketWorkerEnv) {
    const db = env.MARKET_DB;
    this.store = new SqliteMarketStore(state.storage.sql);
    this.service = new MarketService(this.store, {
      seedCatalog: db ? async () => (await db.prepare("SELECT security_id FROM market_securities WHERE enabled = 1").all<{ security_id: string }>()).results?.map((row) => row.security_id) ?? [] : undefined,
      // History work that did not fit one invocation's subrequest budget continues in an alarm.
      scheduleContinuation: () => { void state.storage.setAlarm(Date.now() + 2_000).catch(() => undefined); },
    });
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/tick") {
      await this.service.tick();
      return new Response(null, { status: 204 });
    }
    // Cloud clients may only add one explicitly selected security at a time.
    return serveMarket(request, this.service, { maxRegister: 1 });
  }

  async alarm() {
    // A retired instance has no catalog: clear it once, as the previous backend did.
    if (!this.store.hasCatalog()) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.service.tick();
  }
}
