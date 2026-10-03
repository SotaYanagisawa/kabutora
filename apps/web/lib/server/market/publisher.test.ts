import { afterEach, describe, expect, it, vi } from "vitest";
import { publicPayloadChunks, publishResource, readPublicResource } from "./publisher";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../cloudflare-market-env";
function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    for (const file of ["0008_market_publications.sql", "0011_market_chunk_descriptors.sql"])
        sqlite.exec(readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), "utf8"));
    class Statement implements D1PreparedStatementLike {
        values: unknown[] = [];
        constructor(private sql: string) { }
        bind(...values: unknown[]) {
            if (values.length > 100)
                throw Error("too many bindings");
            this.values = values;
            return this;
        }
        all<T>() { return Promise.resolve({ success: true, results: sqlite.prepare(this.sql).all(...this.values as (string | number)[]) as T[] }); }
        first<T>() { return Promise.resolve((sqlite.prepare(this.sql).get(...this.values as (string | number)[]) ?? null) as T | null); }
        run() { sqlite.prepare(this.sql).run(...this.values as (string | number)[]); return Promise.resolve({ success: true }); }
    }
    const db: D1DatabaseLike = { prepare: (sql) => new Statement(sql), batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
    return { db, sqlite };
}
describe("immutable public publications", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("serves conditional cached public reads, bypasses on refresh and retains stale data during storage failure", async () => {
        const { db, sqlite } = fixture();
        const entries = new Map<string, Response>();
        vi.stubGlobal("caches", { default: { match: async (request: Request) => entries.get(request.url)?.clone(), put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()); } } });
        try {
            await publishResource(db, "quotes", { quotes: [], benchmarks: [] });
            const url = "https://example.test/api/market/data?resource=quotes";
            const initial = await readPublicResource(db, new Request(url));
            const first = await initial.json();
            expect(first.chunk_keys).toHaveLength(first.chunk_count);
            const prepare = db.prepare;
            db.prepare = () => { throw Error("storage unavailable"); };
            const warm = await readPublicResource(db, new Request(url, { headers: { "If-None-Match": initial.headers.get("ETag")! } }));
            expect(warm.status).toBe(304);
            expect(warm.headers.get("Cache-Control")).toBe("private, no-store");
            const stale = await readPublicResource(db, new Request(url, { headers: { "Cache-Control": "no-cache" } }));
            expect(stale.headers.get("X-Market-Stale")).toBe("true");
            expect(await stale.json()).toEqual(first);
            db.prepare = prepare;
            await publishResource(db, "quotes", { quotes: [], benchmarks: [], coverage: { registered: 1, quoted: 0 } });
            const fresh = await readPublicResource(db, new Request(url, { headers: { "Cache-Control": "no-cache" } }));
            expect((await fresh.json()).revision).not.toBe(first.revision);
            expect((await readPublicResource(db, new Request(url + "&uid=private"))).status).toBe(400);
        }
        finally {
            sqlite.close();
        }
    });
    it("bounds chunks without losing rows", () => {
        const bars = Array.from({ length: 10000 }, (_, i) => ({ securityId: "sec-us-aapl", date: "2026-09-01", close: String(i + 1) }));
        const chunks = publicPayloadChunks({ bars });
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 240000)).toBe(true);
        expect(chunks.flatMap((chunk) => JSON.parse(chunk).bars)).toEqual(bars);
    });
    it("leaves a complete previous generation readable if chunk writes fail", async () => {
        const { db, sqlite } = fixture();
        try {
            await publishResource(db, "quotes", { quotes: [], benchmarks: [] });
            const request = new Request("https://example.test/api/market/data?resource=quotes");
            const original = await (await readPublicResource(db, request)).json();
            const prepare = db.prepare;
            db.prepare = (query) => {
                if (query.startsWith("INSERT OR IGNORE INTO market_publication_chunks"))
                    throw Error("storage unavailable");
                return prepare(query);
            };
            await expect(publishResource(db, "quotes", { quotes: [{ securityId: "sec-us-aapl", price: "200" }] })).rejects.toThrow();
            expect(await (await readPublicResource(db, request)).json()).toEqual(original);
            expect(await publishResource(db, "quotes", { quotes: [], benchmarks: [] })).toBe(false);
        }
        finally {
            sqlite.close();
        }
    });
});
