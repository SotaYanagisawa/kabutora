import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { persistPublicEvents } from "./events";
import { persistObservations, readObservations, persistHistoryMonths, readHistoryMonths } from "./observations";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../cloudflare-market-env";
import type { MarketQuoteBatchResult } from "../../server-market-types";
function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    for (const name of ["0001_market_snapshots.sql", "0002_market_distributions.sql", "0003_market_distribution_coverage.sql", "0009_market_observations.sql"])
        sqlite.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
    let queries = 0;
    class Statement implements D1PreparedStatementLike {
        values: (string | number | null)[] = [];
        constructor(private query: string) { }
        bind(...values: unknown[]) { expect(values.length).toBeLessThanOrEqual(100); this.values = values as (string | number | null)[]; return this; }
        async all<T>() { queries++; return { success: true, results: sqlite.prepare(this.query).all(...this.values) as T[] }; }
        async first<T>() { queries++; return (sqlite.prepare(this.query).get(...this.values) ?? null) as T | null; }
        async run() { queries++; sqlite.prepare(this.query).run(...this.values); return { success: true }; }
    }
    const db: D1DatabaseLike = { prepare: (query) => new Statement(query), batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
    return { db, sqlite, queries: () => queries };
}
const result = (price: string, marketTimestamp: string, generatedAt: string): MarketQuoteBatchResult => ({ generatedAt, marketSessions: [], quotes: [{ securityId: "sec-us-aapl-xnas", symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price, marketTimestamp, fetchedAt: generatedAt, freshness: "near_live", provider: "fixture", session: "regular", priceType: "last_trade", venueCode: "US", validationStatus: "valid" }], intraday: [], failures: [], coverage: { requested: 1, returned: 1, fresh: 1, stale: 0, suspect: 0 } });
it("separates observation time from successful unchanged checks and refuses regression", async () => {
    const { db, sqlite } = fixture();
    try {
        await persistObservations(db, result("200", "2026-10-01T12:00:00Z", "2026-10-01T12:01:00Z"));
        await persistObservations(db, result("199", "2026-10-01T11:00:00Z", "2026-10-01T12:05:00Z"));
        const quote = (await readObservations(db)).get("sec-us-aapl")!;
        expect(quote.price).toBe("200");
        expect(quote.marketTimestamp).toBe("2026-10-01T12:00:00Z");
        expect(quote.fetchedAt).toBe("2026-10-01T12:05:00Z");
    }
    finally {
        sqlite.close();
    }
});
it("stores thirty years in bounded months with few queries, preserving unrelated dates during corrections", async () => {
    const { db, sqlite, queries } = fixture();
    try {
        const bars = Array.from({ length: 360 }, (_, i) => ({ securityId: "sec-us-aapl", date: `${1997 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}-01`, close: "100", provider: "fixture" }));
        await persistHistoryMonths(db, bars, "2026-10-01T00:00:00Z");
        expect(queries()).toBeLessThan(25);
        await persistHistoryMonths(db, [{ ...bars[0], close: "101" }], "2026-10-02T00:00:00Z");
        const stored = await readHistoryMonths(db);
        expect(stored).toHaveLength(360);
        expect(stored[0].close).toBe("101");
        expect(stored[1].close).toBe("100");
    }
    finally {
        sqlite.close();
    }
});
it("persists decades of distributions in few statements and refuses lower confidence corrections", async () => {
    const { db, sqlite, queries } = fixture();
    try {
        sqlite.exec("INSERT INTO market_securities VALUES ('sec-us-aapl','AAPL','AAPL','XNAS','USD','US','stock',1,'2026-10-01','2026-10-01','2026-10-01')");
        const distributions = Array.from({ length: 360 }, (_, i) => ({ id: `event-${i}`, securityId: "sec-us-aapl", type: "CASH_DIVIDEND" as const, exDate: `${1997 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}-01`, amountPerUnit: "1", currency: "USD", confidence: "official" as const, sourceProvider: "fixture" }));
        const batch = { generatedAt: "2026-10-01T00:00:00Z", requestedFrom: "2000-01-01", marketSessions: [], bars: [], corporateActions: [], distributions, inceptionDates: {}, failures: [], coverage: { requested: 1, returned: 1 }, coveredSecurityIds: ["sec-us-aapl"], quality: { checksum: "fixture", status: "ready" } };
        await persistPublicEvents(db, batch);
        expect(queries()).toBe(5);
        expect(sqlite.prepare("SELECT COUNT(*) AS n FROM market_distributions").get()?.n).toBe(360);
        await persistPublicEvents(db, { ...batch, distributions: [{ ...distributions[0], amountPerUnit: "2", confidence: "reported" }] });
        expect(sqlite.prepare("SELECT amount_per_unit FROM market_distributions WHERE event_id='event-0'").get()?.amount_per_unit).toBe("1");
        await persistPublicEvents(db, { ...batch, distributions: [{ ...distributions[0], amountPerUnit: "3" }] });
        expect(sqlite.prepare("SELECT amount_per_unit FROM market_distributions WHERE event_id='event-0'").get()?.amount_per_unit).toBe("3");
    }
    finally {
        sqlite.close();
    }
});
