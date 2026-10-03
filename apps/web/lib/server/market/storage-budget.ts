import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "../../cloudflare-market-env";
import type { CoordinatorStore } from "./coordinator-store";
/** Leave invocation and daily headroom; every billed D1 result updates durable totals. */
export function budgetedMarketDatabase(db: D1DatabaseLike, store: CoordinatorStore): D1DatabaseLike {
    let queries = 0;
    const day = new Date().toISOString().slice(0, 10);
    const usage = store.d1Usage(day);
    const admit = (count: number) => {
        if (queries + count > 45)
            throw new Error("market_invocation_storage_budget");
        if (usage.reads >= 1990000 || usage.writes >= 58000)
            throw new Error("d1_daily_budget_deferred");
        queries += count;
    };
    const account = (results: D1ResultLike<unknown>[]) => {
        for (const result of results) {
            usage.reads += result.meta?.rows_read ?? 0;
            usage.writes += result.meta?.rows_written ?? 0;
        }
    };
    const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
    const wrap = (statement: D1PreparedStatementLike): D1PreparedStatementLike => {
        const wrapped: D1PreparedStatementLike = {
            bind(...values) {
                if (values.length > 100)
                    throw new Error("market_storage_bind_limit");
                return wrap(statement.bind(...values));
            },
            async all<T>() { admit(1); const result = await statement.all<T>(); account([result]); return result; },
            async first<T>(column?: string) { admit(1); const result = await statement.all<Record<string, unknown>>(); account([result]); const row = result.results?.[0]; return (column ? row?.[column] : row) as T | null ?? null; },
            async run() { admit(1); const result = await statement.run(); account([result]); return result; },
        };
        originals.set(wrapped, statement);
        return wrapped;
    };
    return { prepare: (query) => wrap(db.prepare(query)), async batch(statements) { admit(statements.length); const results = await db.batch(statements.map((statement) => originals.get(statement) ?? statement)); account(results); return results; } };
}
