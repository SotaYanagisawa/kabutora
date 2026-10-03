import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CoordinatorStore, type SqlLike } from "./coordinator-store";
import { publishHistoryParts, readHistoryPart } from "./history-publication";
import { publishResource, readPublicResource } from "./publisher";
import { decodePublicHistory } from "../../public-history-codec";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../cloudflare-market-env";
function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    for (const name of ["0001_market_snapshots.sql", "0008_market_publications.sql", "0009_market_observations.sql", "0010_market_publication_generations.sql", "0011_market_chunk_descriptors.sql"])
        sqlite.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
    let queries = 0, largestRead = 0, failAt = 0;
    class Statement implements D1PreparedStatementLike {
        values: (string | number | null)[] = [];
        constructor(private query: string) { }
        bind(...values: unknown[]) { expect(values.length).toBeLessThanOrEqual(100); this.values = values as (string | number | null)[]; return this; }
        before() {
            queries++;
            if (queries === failAt)
                throw Error("interrupted_publication");
        }
        async all<T>() {
            this.before();
            const rows = sqlite.prepare(this.query).all(...this.values);
            if (this.query.includes("market_history_chunks")) {
                expect(this.query).toContain("WHERE instrument_id=?");
                largestRead = Math.max(largestRead, rows.length);
            }
            return { success: true, results: rows as T[] };
        }
        async first<T>() { this.before(); return (sqlite.prepare(this.query).get(...this.values) ?? null) as T | null; }
        async run() { this.before(); sqlite.prepare(this.query).run(...this.values); return { success: true }; }
    }
    const db: D1DatabaseLike = { prepare: query => new Statement(query), batch: async (statements) => Promise.all(statements.map(statement => statement.run())) };
    const sql: SqlLike = { exec<T extends Record<string, unknown>>(query: string, ...values: (string | number | null)[]) {
            if (!values.length && query.includes(";")) {
                sqlite.exec(query);
                return { toArray: () => [] };
            }
            const rows = sqlite.prepare(query).all(...values) as T[];
            return { toArray: () => rows };
        } };
    return { db, sqlite, store: () => new CoordinatorStore(sql), reset: (failure = 0) => { queries = 0; failAt = failure; }, queries: () => queries, largestRead: () => largestRead };
}
it("publishes a 200-instrument, thirty-year catalog in bounded resumable invocations without replacing the previous manifest early", async () => {
    const f = fixture();
    try {
        const ids = Array.from({ length: 200 }, (_, i) => `sec-us-fixture-${String(i).padStart(3, "0")}`);
        const insert = f.sqlite.prepare("INSERT INTO market_history_chunks VALUES (?,?,?,?)");
        f.sqlite.exec("BEGIN");
        for (const id of ids)
            for (let month = 0; month < 360; month++) {
                const prefix = `${1997 + Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, "0")}`;
                const bars = Array.from({ length: 21 }, (_, i) => ({ securityId: id, date: `${prefix}-${String(i + 1).padStart(2, "0")}`, close: "100.125", provider: "fixture" }));
                insert.run(id, prefix, JSON.stringify(bars), "2026-10-01T00:00:00Z");
            }
        f.sqlite.exec("COMMIT");
        await publishResource(f.db, "history", { bars: [], corporateActions: [], inceptionDates: {} });
        const request = new Request("https://example.test/api/market/data?resource=history");
        const original = await (await readPublicResource(f.db, request)).json();
        // A restart after one fully persisted part does not lose that progress.
        f.reset(12);
        await expect(publishHistoryParts(f.db, ids, f.store())).rejects.toThrow("interrupted_publication");
        f.reset();
        expect(await (await readPublicResource(f.db, request)).json()).toEqual(original);
        let result: boolean | undefined;
        let invocations = 0;
        do {
            f.reset();
            result = await publishHistoryParts(f.db, ids, f.store());
            expect(f.queries()).toBeLessThanOrEqual(45);
            invocations++;
        } while (result === undefined && invocations < 100);
        expect(result).toBe(true);
        expect(invocations).toBeLessThan(70);
        expect(f.largestRead()).toBe(360);
        const manifest = await (await readPublicResource(f.db, request)).json();
        expect(manifest.revision).not.toBe(original.revision);
        expect(manifest.chunk_count).toBeGreaterThanOrEqual(200);
        const first = JSON.parse((await readHistoryPart(f.db, manifest.revision, 0))!);
        expect(decodePublicHistory(first.historyBlocks)).toHaveLength(7560);
        expect(first.inceptionDates[ids[0]]).toBe("1997-01-01");
        // Correct one instrument without rebuilding the other 199 parts.
        const row = JSON.parse(String(f.sqlite.prepare("SELECT payload_json FROM market_history_chunks WHERE instrument_id=? AND month='1997-01'").get(ids[0])!.payload_json));
        row[0].close = "101.125";
        f.sqlite.prepare("UPDATE market_history_chunks SET payload_json=? WHERE instrument_id=? AND month='1997-01'").run(JSON.stringify(row), ids[0]);
        f.store().setMetadata("history:pending", JSON.stringify([ids[0]]));
        f.reset();
        expect(await publishHistoryParts(f.db, ids, f.store())).toBe(true);
        expect(f.queries()).toBeLessThanOrEqual(45);
        const next = await (await readPublicResource(f.db, request)).json();
        expect(decodePublicHistory(JSON.parse((await readHistoryPart(f.db, next.revision, 0))!).historyBlocks)[0].close).toBe("101.125");
        expect(decodePublicHistory(JSON.parse((await readHistoryPart(f.db, manifest.revision, 0))!).historyBlocks)[0].close).toBe("100.125");
    }
    finally {
        f.sqlite.close();
    }
}, 60000);
