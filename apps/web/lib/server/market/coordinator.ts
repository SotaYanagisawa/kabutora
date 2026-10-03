import { budgetedMarketDatabase } from "./storage-budget";
import { marketProviderPolicy } from "./provider-policy";
import { admitDuePublicJobs, ingestPublicJob } from "./ingestion";
import type { MarketWorkerEnv } from "../../cloudflare-market-env";
import { CoordinatorStore, type SqlLike } from "./coordinator-store";
import { withProviderExecution } from "./provider-fetch";
import { isD1DailyLimitError, isMarketRefreshJob } from "../../server-market-scheduler";
import { collectJapannextPts } from "../../server-pts-collector";
import { publishMarketResources } from "./publisher";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import { listEnabledMarketSecurities, mergeMarketSecurities, normalizePublicSecurityIds } from "../../server-market-store";
type State = {
    storage: {
        sql: SqlLike;
        setAlarm(time: number): Promise<void>;
    };
    blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>;
};
const DAY = 86400000;
/** One public-data coordinator for the entire private group; no account identifiers. */
export class MarketCoordinator {
    private store: CoordinatorStore;
    private working = false;
    constructor(private state: State, private env: MarketWorkerEnv) {
        this.store = new CoordinatorStore(state.storage.sql);
    }
    async fetch(request: Request) {
        try {
            return await this.handleRequest(request);
        }
        finally {
            this.store.flushUsage();
        }
    }
    private async handleRequest(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/status")
            return Response.json(this.store.diagnostics());
        if (url.pathname === "/register") {
            const body: unknown = await request.json();
            if (typeof body !== "string" || !this.env.MARKET_DB)
                return Response.json({ error: "invalid_public_selection" }, { status: 400 });
            const securities = normalizePublicSecurityIds([body]);
            if (securities.length !== 1)
                return Response.json({ error: "invalid_public_selection" }, { status: 400 });
            return this.state.blockConcurrencyWhile(async () => {
                const db = budgetedMarketDatabase(this.env.MARKET_DB!, this.store);
                const enabled = await listEnabledMarketSecurities(db);
                const catalog = new Set(enabled.map(security => canonicalDomainSecurityId(security.securityId)));
                if (!catalog.has(canonicalDomainSecurityId(body)) && catalog.size >= 200)
                    return Response.json({ error: "public_catalog_capacity" }, { status: 429 });
                const registered = await mergeMarketSecurities(db, securities);
                const scheduledAt = new Date().toISOString(), runId = `market:catalog:${scheduledAt}`;
                for (const kind of ["quotes", "history", "distributions"] as const)
                    this.store.admit({ version: 1, claimId: "durable", runId, kind, scheduledAt, securityIds: [securities[0].securityId] });
                await this.state.storage.setAlarm(Date.now() + 1000);
                return Response.json({ registered, mode: "merge", updatedAt: scheduledAt });
            });
        }
        // Called only through the Worker binding. Search shares durable provider
        // reservations with ingestion without storing the search expression.
        if (url.pathname === "/provider-reservation" || url.pathname === "/provider-outcome") {
            const value: unknown = await request.json();
            if (!value || typeof value !== "object" || Array.isArray(value))
                return Response.json({ error: "invalid_provider" }, { status: 400 });
            const body = value as Record<string, unknown>;
            if (!['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'finance.yahoo.co.jp'].includes(String(body.host)))
                return Response.json({ error: "invalid_provider" }, { status: 400 });
            if (url.pathname === "/provider-reservation") {
                try {
                    this.store.reserve(String(body.host));
                }
                catch {
                    return Response.json({ error: "provider_budget_unavailable" }, { status: 429 });
                }
            }
            else {
                if (!Number.isInteger(body.status) || Number(body.status) < 100 || Number(body.status) > 599)
                    return Response.json({ error: "invalid_provider_status" }, { status: 400 });
                this.store.outcome(String(body.host), Number(body.status));
            }
            return new Response(null, { status: 204 });
        }
        if (url.pathname === "/progress")
            return Response.json(this.store.progress(url.searchParams.get("runId") ?? ""));
        if (url.pathname === "/refresh") {
            if (!this.env.MARKET_DB)
                return Response.json({ error: "market_refresh_unavailable" }, { status: 503 });
            const bucket = String(Math.floor(Date.now() / 600000));
            const previous = this.store.metadata("manual:bucket") === bucket ? this.store.metadata("manual:result") : undefined;
            if (previous)
                return Response.json(JSON.parse(previous));
            // Set a durable admission marker before yielding to D1. Concurrent members
            // share one public refresh rather than racing the daily budget.
            const runId = `market:manual:${new Date(Math.floor(Date.now() / 600000) * 600000).toISOString()}`;
            const accepted = { runId, accepted: 0, queued: 1, budgetLimited: false };
            this.store.setMetadata("manual:bucket", bucket);
            this.store.setMetadata("manual:result", JSON.stringify(accepted));
            try {
                const result = await admitDuePublicJobs(budgetedMarketDatabase(this.env.MARKET_DB, this.store), this.store, Date.now(), true);
                await this.state.storage.setAlarm(Date.now() + 1000);
                this.store.setMetadata("manual:result", JSON.stringify(result));
                return Response.json(result);
            }
            catch {
                this.store.setMetadata("manual:result", JSON.stringify({ ...accepted, queued: 0, budgetLimited: true }));
                return Response.json({ error: "market_refresh_unavailable" }, { status: 503 });
            }
        }
        if (url.pathname === "/enqueue") {
            const body: unknown = await request.json();
            if (!isMarketRefreshJob(body))
                return Response.json({ error: "market_job_invalid" }, { status: 400 });
            // Queue messages from the former scheduler can safely drain; its
            // manual jobs are replaced by one shared, coalesced public refresh.
            if (body.kind === "manual")
                return new Response(null, { status: 204 });
            const admitted = this.store.admit(body);
            await this.state.storage.setAlarm(Date.now() + 1000);
            return Response.json({ runId: body.runId, queued: admitted, accepted: body.securityIds.length, budgetLimited: admitted === 0 });
        }
        // The existing cron is a watchdog: it only wakes a missing durable alarm.
        if (url.pathname === "/wake") {
            await this.state.storage.setAlarm(Date.now() + 1000);
            return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
    }
    async alarm() {
        if (this.working || !this.env.MARKET_DB)
            return;
        this.working = true;
        const blockedUntil = Number(this.store.metadata("storage:blockedUntil") ?? 0);
        if (blockedUntil > Date.now() || !this.store.sqliteBudgetAvailable()) {
            this.working = false;
            await this.state.storage.setAlarm(Math.max(blockedUntil, Math.floor(Date.now() / DAY) * DAY + DAY + 60000));
            this.store.flushUsage();
            return;
        }
        const db = budgetedMarketDatabase(this.env.MARKET_DB, this.store);
        const now = Date.now();
        const started = performance.now();
        this.store.setMetadata("lastAlarmAt", new Date(now).toISOString());
        // Persist the next wake before network I/O. An eviction cannot lose ingestion.
        await this.state.storage.setAlarm(now + 60000);
        if (this.store.metadata("bootstrap") !== "done") {
            for (const kind of ["quotes", "history", "distributions"])
                this.store.setMetadata(`publication:${kind}`, "pending");
            this.store.setMetadata("bootstrap", "done");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let attempts = 0;
        try {
            const pendingKinds = ["quotes", "benchmarks", "pts", "history", "distributions"].filter((kind) => this.store.metadata(`publication:${kind}`) === "pending");
            if (this.env.KABUTORA_MARKET_BACKEND === "v2" && !pendingKinds.length && Number(this.store.metadata("provider:blockedUntil") ?? 0) <= now)
                await withProviderExecution({
                    signal: controller.signal,
                    reserve: (host) => {
                        if (!marketProviderPolicy(host))
                            throw new Error("provider_host_disallowed");
                        if (++attempts > 35)
                            throw new Error("provider_invocation_budget");
                        this.store.reserve(host);
                    },
                    outcome: (host, status) => this.store.outcome(host, status),
                }, async () => {
                    const bucket = String(Math.floor(now / 600000));
                    if (this.store.metadata("schedule") !== bucket) {
                        await admitDuePublicJobs(db, this.store, now);
                        this.store.setMetadata("schedule", bucket);
                        this.store.cleanup(now);
                    }
                    const minute = String(Math.floor(now / 60000));
                    if (this.store.metadata("pts") !== minute) {
                        const result = await collectJapannextPts(db, now);
                        this.store.setMetadata("pts", minute);
                        if (result.status === "stored")
                            this.store.setMetadata("publication:pts", "pending");
                    }
                    const job = this.store.claim(now);
                    if (job) {
                        try {
                            const body: unknown = JSON.parse(job.body);
                            if (!isMarketRefreshJob(body))
                                throw new Error("market_job_invalid");
                            const result = await ingestPublicJob(db, body);
                            if (body.kind === "history")
                                this.store.setMetadata("history:pending", JSON.stringify([...new Set([...JSON.parse(this.store.metadata("history:pending") ?? "[]"), ...body.securityIds])]));
                            this.store.setMetadata(`publication:${body.kind}`, "pending");
                            if (result.failedIds.length && job.attempts < 5)
                                this.store.retrySubset(job.id, body, result.failedIds, now + Math.min(3600000, 60000 * 2 ** job.attempts));
                            else
                                this.store.finish(job.id, result.failed ? "publishing_partial" : "publishing");
                        }
                        catch (error) {
                            const message = error instanceof Error ? error.message : "market_job_failed";
                            const deferred = Number(this.store.metadata("provider:blockedUntil") ?? 0) > now || isD1DailyLimitError(error) || ["provider_budget_deferred", "provider_daily_budget_deferred", "sqlite_daily_budget_deferred", "d1_daily_budget_deferred"].includes(message);
                            const retry = message === "market_invocation_storage_budget" ? now + 1000 : deferred ? Math.floor(now / DAY) * DAY + DAY + 60000 : now + Math.min(3600000, 60000 * 2 ** job.attempts);
                            this.store.finish(job.id, deferred ? "budget_deferred" : job.attempts >= 5 ? "failed" : "retry_at", retry);
                        }
                    }
                });
            // Publication is a durable outbox. Crashes retry idempotently; readers see
            // either the complete previous generation or the complete new generation.
            for (const kind of ["quotes", "benchmarks", "pts", "history", "distributions"]) {
                if (this.store.metadata(`publication:${kind}`) !== "pending")
                    continue;
                const changed = await publishMarketResources(db, kind, this.store);
                if (changed === undefined)
                    break;
                this.store.setMetadata(`publication:${kind}`, "done");
                this.store.published(kind, changed);
                this.store.setMetadata("lastPublicationAt", new Date().toISOString());
                console.log("market_publication_completed", JSON.stringify({ kind, changed, elapsedMs: Math.round(performance.now() - started) }));
                break;
            }
        }
        catch (error) {
            // No raw provider URLs, portfolio values, tokens or upstream bodies in logs.
            if (isD1DailyLimitError(error) || (error instanceof Error && error.message === "d1_daily_budget_deferred"))
                this.store.setMetadata("storage:blockedUntil", String(Math.floor(now / DAY) * DAY + DAY + 60000));
            console.warn("market_coordinator_retry", isD1DailyLimitError(error) ? "storage_budget" : "dependency_unavailable");
        }
        finally {
            clearTimeout(timer);
            this.working = false;
            this.store.flushUsage();
            const storageUntil = Number(this.store.metadata("storage:blockedUntil") ?? 0);
            const providerUntil = Number(this.store.metadata("provider:blockedUntil") ?? 0);
            const waitingPublication = ["quotes", "benchmarks", "pts", "history", "distributions"].some((kind) => this.store.metadata(`publication:${kind}`) === "pending");
            await this.state.storage.setAlarm(storageUntil > now ? storageUntil : providerUntil > now && !waitingPublication ? providerUntil : waitingPublication ? now + 1000 : this.store.nextDue());
        }
    }
}
