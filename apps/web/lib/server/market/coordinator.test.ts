import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { MarketCoordinator } from "./coordinator";
import { CoordinatorStore, type SqlLike } from "./coordinator-store";
const dependencies = vi.hoisted(() => ({ publish: vi.fn(), ingest: vi.fn().mockResolvedValue({ failed: 0, failedIds: [] }) }));
vi.mock("./ingestion", () => ({ admitDuePublicJobs: vi.fn(), ingestPublicJob: dependencies.ingest }));
vi.mock("./publisher", () => ({ publishMarketResources: dependencies.publish }));
it("resumes publication after eviction without refetching a successfully persisted job", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const sql: SqlLike = { exec<T extends Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]) {
            if (!bindings.length && query.includes(";")) {
                sqlite.exec(query);
                return { toArray: () => [] };
            }
            const rows = sqlite.prepare(query).all(...bindings) as T[];
            return { toArray: () => rows };
        } };
    const store = new CoordinatorStore(sql);
    const now = Date.now();
    store.setMetadata("bootstrap", "done");
    store.setMetadata("schedule", String(Math.floor(now / 600000)));
    store.setMetadata("pts", String(Math.floor(now / 60000)));
    store.admit({ version: 1, claimId: "fixture", runId: "market:fixture", kind: "quotes", securityIds: ["sec-us-aapl"], scheduledAt: new Date(now).toISOString() }, now);
    const state = { storage: { sql, setAlarm: vi.fn().mockResolvedValue(undefined) }, blockConcurrencyWhile: async <T>(work: () => Promise<T>) => work() };
    const env = { KABUTORA_MARKET_BACKEND: "v2", MARKET_DB: { prepare: vi.fn(), batch: vi.fn() } };
    dependencies.publish.mockRejectedValueOnce(new Error("storage interrupted")).mockResolvedValue(true);
    try {
        await new MarketCoordinator(state, env).alarm();
        expect(store.progress("market:fixture").status).toBe("pending");
        await new MarketCoordinator(state, env).alarm();
        expect(store.progress("market:fixture").status).toBe("complete");
        expect(dependencies.ingest).toHaveBeenCalledTimes(1);
        expect(state.storage.setAlarm).toHaveBeenCalled();
    }
    finally {
        sqlite.close();
    }
});
