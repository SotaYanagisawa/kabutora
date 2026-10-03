import { persistPublicEvents } from "./events";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import type { D1DatabaseLike } from "../../cloudflare-market-env";
import type { MarketRefreshJob } from "../../server-market-types";
import { fetchMarketBenchmarks, fetchMarketHistoryBatch, fetchMarketQuoteBatch } from "../../server-market-provider";
import { listEnabledMarketSecurities, readStoredQuotes, upsertBenchmarks } from "../../server-market-store";
import { persistHistoryMonths, persistObservations, readObservations } from "./observations";
import { scheduledQuoteTargets, marketRefreshBatches } from "../../server-market-scheduler";
import type { CoordinatorStore } from "./coordinator-store";
/** The durable scheduler has no queue claims, isolate locks, or D1 run bookkeeping. */
export async function admitDuePublicJobs(db: D1DatabaseLike, store: CoordinatorStore, now: number, manual = false) {
    const scheduledAt = new Date(Math.floor(now / 600000) * 600000).toISOString();
    const runId = `market:${manual ? "manual:" : ""}${scheduledAt}`;
    const securities = await listEnabledMarketSecurities(db);
    const observations = await readObservations(db);
    // Existing public cache seeds the replacement; encrypted account data is never involved.
    const legacy = await readStoredQuotes(db);
    const quotes = new Map([...legacy, ...observations]);
    for (const security of securities) {
        const quote = observations.get(canonicalDomainSecurityId(security.securityId));
        if (quote)
            quotes.set(security.securityId, quote);
    }
    const ids = manual ? securities.map((security) => security.securityId) : scheduledQuoteTargets(securities, quotes, now);
    let queued = 0;
    const admit = (kind: MarketRefreshJob["kind"], securityIds: string[], date = scheduledAt) => { queued += store.admit({ version: 1, claimId: "durable", runId, kind, securityIds, scheduledAt: date }, now); };
    for (const batch of marketRefreshBatches(ids, 8))
        admit("quotes", batch);
    admit("benchmarks", []);
    if (!manual) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (store.metadata("history:day") !== day) {
            for (const security of securities)
                admit("history", [security.securityId], `${day}T00:00:00.000Z`);
            store.setMetadata("history:day", day);
        }
        const week = String(Math.floor(now / (7 * 86400000)));
        if (store.metadata("distributions:week") !== week) {
            for (const security of securities)
                admit("distributions", [security.securityId]);
            store.setMetadata("distributions:week", week);
        }
    }
    return { runId, accepted: ids.length, queued, budgetLimited: queued === 0 && ids.length > 0 && store.progress(runId).status === "unknown" };
}
export async function ingestPublicJob(db: D1DatabaseLike, job: MarketRefreshJob) {
    if (job.kind === "quotes") {
        const result = await fetchMarketQuoteBatch(job.securityIds, { force: job.runId.startsWith("market:manual:"), includeIntraday: true, intradayRange: "1d", concurrency: 2 });
        if (!result.quotes.length)
            throw new Error("provider_quote_unavailable");
        await persistObservations(db, result);
        return { failed: result.failures.length, failedIds: result.failures.map(failure => failure.securityId) };
    }
    if (job.kind === "benchmarks") {
        const result = await fetchMarketBenchmarks();
        if (!result.benchmarks.length)
            throw new Error("provider_benchmark_unavailable");
        await upsertBenchmarks(db, result.benchmarks);
        return { failed: result.failures.length, failedIds: [] as string[] };
    }
    if (job.kind === "history") {
        const result = await fetchMarketHistoryBatch(job.securityIds);
        if (!result.coverage.returned)
            throw new Error("provider_history_unavailable");
        await persistHistoryMonths(db, result.bars, result.generatedAt);
        for (const [id, inceptionDate] of Object.entries(result.inceptionDates)) {
            await db.prepare("INSERT INTO market_instrument_metadata VALUES (?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET inception_date=excluded.inception_date,checked_at=excluded.checked_at").bind(canonicalDomainSecurityId(id), inceptionDate, result.generatedAt).run();
        }
        await persistPublicEvents(db, { ...result, coveredSecurityIds: [], distributions: [] });
        return { failed: result.failures.length, failedIds: result.failures.map(failure => failure.securityId) };
    }
    if (job.kind === "distributions") {
        const result = await fetchMarketHistoryBatch(job.securityIds, { from: "2000-01-01", distributionsOnly: true });
        if (!result.coverage.returned)
            throw new Error("provider_distributions_unavailable");
        await persistPublicEvents(db, { ...result, bars: [] });
        return { failed: result.failures.length, failedIds: result.failures.map(failure => failure.securityId) };
    }
    throw new Error("obsolete_market_job");
}
