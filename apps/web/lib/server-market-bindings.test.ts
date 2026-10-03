import { expect, it } from "vitest";
import { readCachedDistributions, readCachedHistory, readUsIntradayBars } from "./server-market-store";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./cloudflare-market-env";
it("keeps every D1 query under the binding ceiling after expanding US venue aliases", async () => {
    const counts: number[] = [];
    class Statement implements D1PreparedStatementLike {
        bind(...values: unknown[]) {
            counts.push(values.length);
            if (values.length > 100)
                throw Error("too many parameters");
            return this;
        }
        async all<T>() { return { success: true, results: [] as T[] }; }
        async first<T>() { return null as T | null; }
        async run() { return { success: true }; }
    }
    const db: D1DatabaseLike = { prepare: () => new Statement(), batch: async () => [] };
    const ids = Array.from({ length: 50 }, (_, i) => `sec-us-test${i}`);
    await readUsIntradayBars(db, ids.slice(0, 20));
    await readCachedHistory(db, ids);
    await readCachedDistributions(db, ids);
    expect(counts.length).toBeGreaterThan(6);
    expect(Math.max(...counts)).toBeLessThanOrEqual(90);
});
