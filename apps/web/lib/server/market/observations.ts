import { canonicalDomainSecurityId, type MarketBar, type IntradayBar } from "@kabutora/domain";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../cloudflare-market-env";
import type { MarketQuoteBatchResult, ServerRemoteQuote } from "../../server-market-types";
import { validateMarketPayload } from "../../market-payload-validation";
async function execute(db: D1DatabaseLike, statements: D1PreparedStatementLike[]) {
    for (let offset = 0; offset < statements.length; offset += 20) {
        const result = await db.batch(statements.slice(offset, offset + 20));
        if (result.some((row) => !row.success))
            throw new Error("market_observation_write_failed");
    }
}
export async function persistObservations(db: D1DatabaseLike, result: MarketQuoteBatchResult) {
    validateMarketPayload(result);
    const statements: D1PreparedStatementLike[] = [];
    const ids = [...new Set(result.quotes.map((quote) => canonicalDomainSecurityId(quote.securityId)))];
    const existing = new Map<string, IntradayBar[]>();
    if (ids.length) {
        const rows = await db.prepare(`SELECT security_id,payload_json FROM market_intraday WHERE security_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{
            security_id: string;
            payload_json: string;
        }>();
        for (const row of rows.results ?? []) {
            try {
                const parsed: unknown = JSON.parse(row.payload_json);
                validateMarketPayload({ intraday: parsed });
                existing.set(row.security_id, parsed as IntradayBar[]);
            }
            catch { /* Replace only corrupt public cache rows. */ }
        }
    }
    for (const quote of result.quotes) {
        const canonical = canonicalDomainSecurityId(quote.securityId);
        statements.push(db.prepare(`INSERT INTO market_observations VALUES (?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET
    payload_json=CASE WHEN excluded.observation_at>=market_observations.observation_at THEN excluded.payload_json ELSE market_observations.payload_json END,
    observation_at=MAX(market_observations.observation_at,excluded.observation_at),checked_at=MAX(market_observations.checked_at,excluded.checked_at)`).bind(canonical, JSON.stringify({ ...quote, securityId: canonical }), quote.marketTimestamp, result.generatedAt));
        for (const alias of new Set([canonical, quote.securityId]))
            statements.push(db.prepare("INSERT OR IGNORE INTO market_instrument_aliases VALUES (?,?)").bind(alias, canonical));
        const cutoff = Date.parse(result.generatedAt) - 7 * 86400000;
        const incoming = result.intraday.filter((bar) => canonicalDomainSecurityId(bar.securityId) === canonical);
        const bars = [...new Map([...(existing.get(canonical) ?? []), ...incoming].filter((bar) => Date.parse(bar.timestamp) >= cutoff).map((bar) => [bar.timestamp, bar])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-2000);
        if (bars.length) {
            statements.push(db.prepare("INSERT INTO market_intraday(security_id,payload_json,first_timestamp,last_timestamp,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(security_id) DO UPDATE SET payload_json=excluded.payload_json,first_timestamp=excluded.first_timestamp,last_timestamp=excluded.last_timestamp,updated_at=excluded.updated_at WHERE payload_json!=excluded.payload_json").bind(canonical, JSON.stringify(bars.map((bar) => ({ ...bar, securityId: canonical }))), bars[0].timestamp, bars.at(-1)!.timestamp, result.generatedAt));
        }
    }
    await execute(db, statements);
}
export async function readObservations(db: D1DatabaseLike) {
    const rows = await db.prepare("SELECT instrument_id,payload_json,checked_at FROM market_observations").all<{
        instrument_id: string;
        payload_json: string;
        checked_at: string;
    }>();
    const quotes = new Map<string, ServerRemoteQuote>();
    for (const row of rows.results ?? []) {
        try {
            const value: unknown = JSON.parse(row.payload_json);
            validateMarketPayload({ quotes: [value] });
            const quote = value as ServerRemoteQuote;
            quotes.set(row.instrument_id, { ...quote, fetchedAt: row.checked_at });
        }
        catch { /* A rejected public observation is independently repairable. */ }
    }
    return quotes;
}
export async function persistHistoryMonths(db: D1DatabaseLike, bars: MarketBar[], checkedAt: string) {
    validateMarketPayload({ bars });
    const groups = new Map<string, MarketBar[]>();
    for (const bar of bars) {
        const id = canonicalDomainSecurityId(bar.securityId), key = `${id}|${bar.date.slice(0, 7)}`;
        const group = groups.get(key) ?? [];
        group.push({ ...bar, securityId: id });
        groups.set(key, group);
    }
    const statements: D1PreparedStatementLike[] = [];
    const byInstrument = new Map<string, Map<string, MarketBar[]>>();
    for (const key of groups.keys()) {
        const [id] = key.split("|");
        if (byInstrument.has(id))
            continue;
        const result = await db.prepare("SELECT month,payload_json FROM market_history_chunks WHERE instrument_id=?").bind(id).all<{
            month: string;
            payload_json: string;
        }>();
        const months = new Map<string, MarketBar[]>();
        for (const row of result.results ?? []) {
            const parsed: unknown = JSON.parse(row.payload_json);
            validateMarketPayload({ bars: parsed });
            months.set(row.month, parsed as MarketBar[]);
        }
        byInstrument.set(id, months);
    }
    const rows: Array<Array<string>> = [];
    for (const [key, incoming] of groups) {
        const [id, month] = key.split("|");
        const existing = byInstrument.get(id)?.get(month) ?? [];
        const merged = [...new Map([...existing, ...incoming].map((bar) => [bar.date, bar])).values()].sort((a, b) => a.date.localeCompare(b.date));
        const payload = JSON.stringify(merged);
        if (new TextEncoder().encode(payload).length > 240000)
            throw new Error("market_history_month_too_large");
        rows.push([id, month, payload, checkedAt]);
    }
    // Twenty month rows per SQL statement keep 80 bindings, and decades of data
    // fit under the 50-query invocation ceiling without per-month read queries.
    for (let offset = 0; offset < rows.length; offset += 20) {
        const chunk = rows.slice(offset, offset + 20);
        statements.push(db.prepare(`INSERT INTO market_history_chunks VALUES ${chunk.map(() => "(?,?,?,?)").join(",")} ON CONFLICT(instrument_id,month) DO UPDATE SET payload_json=excluded.payload_json,checked_at=excluded.checked_at WHERE payload_json!=excluded.payload_json`).bind(...chunk.flat()));
    }
    await execute(db, statements);
}
export async function readHistoryMonths(db: D1DatabaseLike, instrumentId?: string) {
    const statement = instrumentId ? db.prepare("SELECT payload_json FROM market_history_chunks WHERE instrument_id=? ORDER BY month").bind(instrumentId) : db.prepare("SELECT payload_json FROM market_history_chunks ORDER BY instrument_id,month");
    const result = await statement.all<{
        payload_json: string;
    }>();
    const bars: MarketBar[] = [];
    for (const row of result.results ?? []) {
        const parsed: unknown = JSON.parse(row.payload_json);
        validateMarketPayload({ bars: parsed });
        bars.push(...parsed as MarketBar[]);
    }
    return bars;
}
