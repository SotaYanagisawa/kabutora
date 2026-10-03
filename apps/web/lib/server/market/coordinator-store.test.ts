import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorStore, PROVIDER_ATTEMPTS_PER_DAY, type SqlLike } from "./coordinator-store";
import type { MarketRefreshJob } from "../../server-market-types";
const databases: DatabaseSync[] = [];
const fixture = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const sql: SqlLike = { exec<T extends Record<string, unknown>>(query: string, ...bindings: Array<string | number | null>) {
            if (!bindings.length && query.includes(";")) {
                db.exec(query);
                return { toArray: () => [] };
            }
            const statement = db.prepare(query);
            const rows = statement.all(...bindings);
            return { toArray: () => rows as T[] };
        } };
    return { db, store: new CoordinatorStore(sql), sql };
};
afterEach(() => {
    for (const db of databases.splice(0))
        db.close();
});
const job: MarketRefreshJob = { version: 1, claimId: "legacy", runId: "market:run", kind: "quotes", securityIds: ["sec-us-aapl"], scheduledAt: "2026-10-01T00:00:00Z" };
describe("durable market admission", () => {
    it("deduplicates overlapping regrouped batches and reports partial completion accurately", () => {
        const { store } = fixture();
        store.admit({ ...job, securityIds: ["sec-us-aapl", "sec-us-msft"] }, 1000);
        store.admit({ ...job, runId: "second", securityIds: ["sec-us-msft", "sec-us-goog"] }, 1000);
        const first = store.claim(1000)!;
        store.finish(first.id, "partial");
        const second = store.claim(1000)!;
        expect(JSON.parse(second.body).securityIds).toEqual(["sec-us-goog"]);
        store.finish(second.id, "succeeded_unchanged");
        expect(store.progress("second").status).toBe("partial");
    });
    it("deduplicates admission, leases work, and restores interrupted work after restart", () => {
        const { store, sql } = fixture();
        expect(store.admit(job, 1000)).toBe(1);
        expect(store.admit(job, 1000)).toBe(0);
        const claimed = store.claim(1000)!;
        expect(claimed.attempts).toBe(1);
        expect(store.claim(2000)).toBeUndefined();
        const restarted = new CoordinatorStore(sql);
        expect(restarted.claim(121001)?.id).toBe(claimed.id);
        restarted.finish(claimed.id, "succeeded_unchanged");
        expect(restarted.progress(job.runId).status).toBe("complete");
    });
    it("reserves every attempt and carries provider cooldowns across restarts", () => {
        const { store, sql, db } = fixture();
        const now = Date.parse("2026-10-01T00:00:00Z");
        store.reserve("provider", now);
        store.outcome("provider", 429, now);
        const restarted = new CoordinatorStore(sql);
        expect(() => restarted.reserve("provider", now + 100)).toThrow("provider_cooldown");
        restarted.reserve("provider", now + 61000);
        db.prepare("UPDATE budget SET attempts=?").run(PROVIDER_ATTEMPTS_PER_DAY);
        expect(() => restarted.reserve("another", now + 61000)).toThrow("provider_budget_deferred");
        expect(() => restarted.reserve("another", now + 86400000)).not.toThrow();
    });
    it("reports unchanged completion independently of quote observation timestamps", () => {
        const { store } = fixture();
        store.admit(job, 1000);
        const claimed = store.claim(1000)!;
        store.finish(claimed.id, "retry_at", 5000);
        expect(store.progress(job.runId).status).toBe("pending");
        expect(store.claim(4999)).toBeUndefined();
        store.claim(5000);
        store.finish(claimed.id, "succeeded_unchanged");
        expect(store.progress(job.runId)).toMatchObject({ status: "complete", pending: 0 });
    });
});
