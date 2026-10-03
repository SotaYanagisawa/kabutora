import { canonicalDomainSecurityId } from "@kabutora/domain";
import { MARKET_REQUEST_BATCH_SIZE } from "./market-fetch-plan";
import { quoteRefreshTargets } from "./market-refresh-plan";
import { portfolioMarketSessions } from "./market-session";
import type { D1DatabaseLike, QueueProducerLike } from "./cloudflare-market-env";
import { fetchMarketBenchmarks, fetchMarketHistoryBatch, fetchMarketQuoteBatch } from "./server-market-provider";
import { runUpstreamCanary } from "./upstream-canary";
import {
  MARKET_PROVIDER_CALL_BUDGET,
  MARKET_QUEUE_MESSAGE_BUDGET,
  MARKET_D1_WRITE_BUDGET,
  claimRefreshJob,
  cleanupRefreshMetadata,
  createRefreshRun,
  finishRefreshRun,
  incrementDailyUsage,
  listDueDistributionSecurityIds,
  listDueHistorySecurityIds,
  listEnabledMarketSecurities,
  markRefreshJob,
  mergeMarketSecurities,
  normalizePublicSecurityIds,
  readDailyUsage,
  readStoredQuotes,
  upsertBenchmarks,
  upsertHistoryBatch,
  upsertQuoteBatch,
} from "./server-market-store";
import type { MarketRefreshJob, PublicSecurityDescriptor, ServerRemoteQuote } from "./server-market-types";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const FUND_REFRESH_MS = 20 * 60 * 60 * 1000;
const HISTORY_REFRESH_MS = 24 * 60 * 60 * 1000;
const DISTRIBUTION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_REGISTRY_MS = 30 * 24 * 60 * 60 * 1000;
const CLOSED_BENCHMARK_REFRESH_MS = 4 * 60 * 60 * 1000;
// Queue consumers have the same 50 external-subrequest ceiling as HTTP
// requests. Chart, quote, name and fallback requests all count toward it.
export const MARKET_QUOTE_JOB_SIZE = MARKET_REQUEST_BATCH_SIZE;
// Full-range distribution backfills can include decades of price bars. Keep
// queue jobs small so a single slow provider cannot exhaust a Worker invocation.
export const MARKET_HISTORY_JOB_SIZE = 2;

function tenMinuteBucket(value: number) {
  return new Date(Math.floor(value / TEN_MINUTES_MS) * TEN_MINUTES_MS).toISOString();
}

function distributionBucket(value: number) {
  return new Date(Math.floor(value / DISTRIBUTION_REFRESH_MS) * DISTRIBUTION_REFRESH_MS).toISOString();
}

function dayBucket(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function marketRefreshBatches(ids: string[], size = MARKET_REQUEST_BATCH_SIZE) {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

export function dedupeScheduledSecurities(securities: PublicSecurityDescriptor[]) {
  const byCanonical = new Map<string, PublicSecurityDescriptor>();
  for (const security of securities) {
    const canonical = canonicalDomainSecurityId(security.securityId);
    const current = byCanonical.get(canonical);
    // Prefer an exchange-qualified identifier because it retains the provider
    // routing detail; storage fans the result back out to canonical variants.
    if (!current || (current.securityId === canonical && security.securityId !== canonical)) {
      byCanonical.set(canonical, security);
    }
  }
  return [...byCanonical.values()];
}

function dueScheduledIds(securities: PublicSecurityDescriptor[], dueIds: string[]) {
  const dueCanonicals = new Set(dueIds.map(canonicalDomainSecurityId));
  return dedupeScheduledSecurities(securities)
    .filter((security) => dueCanonicals.has(canonicalDomainSecurityId(security.securityId)))
    .map((security) => security.securityId);
}

export function scheduledQuoteTargets(securities: PublicSecurityDescriptor[], quotes: Map<string, ServerRemoteQuote>, now: number) {
  securities = dedupeScheduledSecurities(securities);
  const regularIds = securities.filter((security) => security.assetType !== "fund").map((security) => security.securityId);
  const targets = new Set(quoteRefreshTargets(regularIds, Object.fromEntries(quotes), { now }));
  for (const security of securities) {
    if (security.assetType !== "fund") continue;
    const quote = quotes.get(security.securityId) ?? quotes.get(canonicalDomainSecurityId(security.securityId));
    const fetchedAt = Date.parse(quote?.fetchedAt ?? "");
    if (!Number.isFinite(fetchedAt) || now - fetchedAt >= FUND_REFRESH_MS) targets.add(security.securityId);
  }
  return securities.map((security) => security.securityId).filter((securityId) => targets.has(securityId));
}

function refreshJob(kind: MarketRefreshJob["kind"], securityIds: string[], runId: string, scheduledAt: string, bucket: string): MarketRefreshJob {
  return {
    version: 1,
    claimId: `${kind}:${bucket}:${securityIds.join("|")}`,
    runId,
    kind,
    securityIds,
    scheduledAt,
  };
}

export async function selectMarketRefreshJobs(
  candidates: MarketRefreshJob[],
  remainingMessages: number,
  remainingProviderCalls: number,
  claim: (job: MarketRefreshJob) => Promise<boolean>,
  remainingD1Writes = Number.POSITIVE_INFINITY,
) {
  const selected: MarketRefreshJob[] = [];
  let plannedCalls = 0;
  let plannedWrites = 0;
  let budgetLimited = false;
  for (const job of candidates) {
    const calls = job.kind === "benchmarks" ? 7 : job.securityIds.length;
    const writes = job.kind === "quotes"
      ? job.securityIds.length * 4
      : job.kind === "distributions"
        ? job.securityIds.length * 500
        : job.kind === "history"
          ? job.securityIds.length * 4
          : 14;
    if (selected.length >= remainingMessages) {
      budgetLimited = true;
      break;
    }
    if (plannedCalls + calls > remainingProviderCalls) {
      budgetLimited = true;
      continue;
    }
    if (plannedWrites + writes > remainingD1Writes) {
      budgetLimited = true;
      continue;
    }
    if (await claim(job)) {
      selected.push(job);
      plannedCalls += calls;
      plannedWrites += writes;
    }
  }
  return { selected, budgetLimited };
}

export function isMarketRefreshJob(value: unknown): value is MarketRefreshJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<MarketRefreshJob> & Record<string, unknown>;
  if (Object.keys(job).some((key) => !["version", "claimId", "runId", "kind", "securityIds", "scheduledAt"].includes(key))) return false;
  return job.version === 1
    && typeof job.claimId === "string"
    && typeof job.runId === "string"
    && ["quotes", "history", "distributions", "benchmarks", "manual"].includes(String(job.kind))
    && Array.isArray(job.securityIds)
    && (job.kind === "benchmarks"
      ? job.securityIds.length === 0
      : job.securityIds.length > 0 && job.securityIds.length <= (job.kind === "manual" ? 200 : job.kind === "quotes" ? MARKET_QUOTE_JOB_SIZE : MARKET_HISTORY_JOB_SIZE))
    && job.securityIds.every((securityId) => typeof securityId === "string")
    && typeof job.scheduledAt === "string" && Number.isFinite(Date.parse(job.scheduledAt))
    && job.claimId.length <= 2000 && job.runId.length <= 256
    && job.securityIds.every((id) => id.length <= 96 && normalizePublicSecurityIds([id]).length === 1);
}

export async function scheduleMarketRefresh(db: D1DatabaseLike, queue: QueueProducerLike, scheduledTime = Date.now(), options: { canary?: boolean } = {}) {
  const scheduledAt = new Date(scheduledTime).toISOString();
  const bucket = tenMinuteBucket(scheduledTime);
  const runId = `market:${bucket}`;
  await createRefreshRun(db, runId, scheduledAt);

  // Trigger automated upstream schema drift canary checks concurrently
  const canaryPromise = (options.canary === false ? Promise.resolve(null) : runUpstreamCanary()).then(async (report) => {
    if (report?.driftDetected) {
      console.warn("[CANARY_SCHEMA_DRIFT]", JSON.stringify(report));
      await incrementDailyUsage(db, { failures: 1 }).catch(() => undefined);
    }
    return report;
  }).catch((cause) => {
    console.warn("[CANARY_EXECUTION_ERROR]", cause);
    return null;
  });

  const [securities, quotes, usage] = await Promise.all([
    listEnabledMarketSecurities(db, new Date(scheduledTime - ACTIVE_REGISTRY_MS).toISOString()),
    readStoredQuotes(db),
    readDailyUsage(db),
  ]);
  const dueQuotes = scheduledQuoteTargets(securities, quotes, scheduledTime);
  const historyCutoff = new Date(scheduledTime - HISTORY_REFRESH_MS).toISOString();
  const dueHistory = dueScheduledIds(securities, await listDueHistorySecurityIds(db, historyCutoff));
  const distributionCutoff = new Date(scheduledTime - DISTRIBUTION_REFRESH_MS).toISOString();
  const dueDistributions = dueScheduledIds(securities, await listDueDistributionSecurityIds(db, distributionCutoff));
  const sessions = portfolioMarketSessions("ALL", new Date(scheduledTime));
  const hasActiveSession = sessions.some((s) => s.isOpen || s.session !== "closed");
  const benchmarkBucket = hasActiveSession
    ? bucket
    : new Date(Math.floor(scheduledTime / CLOSED_BENCHMARK_REFRESH_MS) * CLOSED_BENCHMARK_REFRESH_MS).toISOString();
  const candidates: MarketRefreshJob[] = [
    ...marketRefreshBatches(dueQuotes, MARKET_QUOTE_JOB_SIZE).map((ids) => refreshJob("quotes", ids, runId, scheduledAt, bucket)),
    refreshJob("benchmarks", [], runId, scheduledAt, benchmarkBucket),
    ...marketRefreshBatches(dueHistory, MARKET_HISTORY_JOB_SIZE).map((ids) => refreshJob("history", ids, runId, scheduledAt, dayBucket(scheduledTime))),
    ...marketRefreshBatches(dueDistributions, MARKET_HISTORY_JOB_SIZE).map((ids) => refreshJob("distributions", ids, runId, scheduledAt, distributionBucket(scheduledTime))),
  ];
  const remainingMessages = Math.max(0, MARKET_QUEUE_MESSAGE_BUDGET - usage.queueMessages);
  const remainingProviderCalls = Math.max(0, MARKET_PROVIDER_CALL_BUDGET - usage.providerCalls);
  const remainingD1Writes = Math.max(0, MARKET_D1_WRITE_BUDGET - usage.quoteWrites - usage.historyWrites);
  const { selected, budgetLimited } = await selectMarketRefreshJobs(
    candidates,
    remainingMessages,
    remainingProviderCalls,
    (job) => claimRefreshJob(db, job),
    remainingD1Writes,
  );
  if (selected.length) {
    await queue.sendBatch(selected.map((body) => ({ body, contentType: "json" as const })));
  }
  await incrementDailyUsage(db, { cronRuns: 1, queueMessages: selected.length });
  await finishRefreshRun(db, runId, dueQuotes.length + dueHistory.length + dueDistributions.length + 7, selected.length, budgetLimited ? "budget_limited" : "complete");
  if (usage.cronRuns === 0) {
    const cleanupCutoff = new Date(scheduledTime - 48 * 60 * 60 * 1000).toISOString();
    await cleanupRefreshMetadata(db, cleanupCutoff);
  }
  const canaryReport = await canaryPromise;
  return { runId, queued: selected.length, dueQuotes: dueQuotes.length, dueHistory: dueHistory.length, dueDistributions: dueDistributions.length, budgetLimited, canaryPassed: canaryReport?.allPassed ?? true };
}

export async function enqueueManualMarketRefresh(
  db: D1DatabaseLike,
  queue: QueueProducerLike,
  requestedSecurityIds: string[],
  requestedAt = Date.now(),
) {
  const scheduledAt = new Date(requestedAt).toISOString();
  const bucket = tenMinuteBucket(requestedAt);
  const runId = `market:manual:${bucket}`;
  const enabled = await listEnabledMarketSecurities(db);
  const requested = new Set(requestedSecurityIds);
  const requestedCanonicals = new Set(requestedSecurityIds.map(canonicalDomainSecurityId));
  const securityIds = dedupeScheduledSecurities(enabled)
    .map((security) => security.securityId)
    .filter((securityId) => requested.has(securityId) || requestedCanonicals.has(canonicalDomainSecurityId(securityId)))
    .sort();
  await createRefreshRun(db, runId, scheduledAt);
  const usage = await readDailyUsage(db);
  const candidates = [
    ...marketRefreshBatches(securityIds, MARKET_QUOTE_JOB_SIZE).map((ids) => refreshJob("quotes", ids, runId, scheduledAt, bucket)),
    refreshJob("benchmarks", [], runId, scheduledAt, bucket),
  ];
  const { selected, budgetLimited } = await selectMarketRefreshJobs(
    candidates,
    Math.max(0, MARKET_QUEUE_MESSAGE_BUDGET - usage.queueMessages),
    Math.max(0, MARKET_PROVIDER_CALL_BUDGET - usage.providerCalls),
    (job) => claimRefreshJob(db, job),
    Math.max(0, MARKET_D1_WRITE_BUDGET - usage.quoteWrites - usage.historyWrites),
  );
  if (selected.length) await queue.sendBatch(selected.map((body) => ({ body, contentType: "json" as const })));
  await incrementDailyUsage(db, { queueMessages: selected.length });
  await finishRefreshRun(db, runId, securityIds.length + 7, selected.length, budgetLimited ? "budget_limited" : "complete");
  return { runId, accepted: securityIds.length, queued: selected.length, budgetLimited };
}

export async function processMarketRefreshJob(db: D1DatabaseLike, job: MarketRefreshJob, queue?: QueueProducerLike) {
  if (job.kind === "manual") {
    if (!queue) throw new Error("market_refresh_queue_unavailable");
    await incrementDailyUsage(db, { queueMessages: 1 });
    const securities = normalizePublicSecurityIds(job.securityIds);
    await mergeMarketSecurities(db, securities);
    const result = await enqueueManualMarketRefresh(db, queue, securities.map((security) => security.securityId), Date.parse(job.scheduledAt));
    return { kind: job.kind, returned: result.accepted, failed: 0 };
  }
  try {
    if (job.kind === "quotes") {
      const result = await fetchMarketQuoteBatch(job.securityIds, { force: job.runId.startsWith("market:manual:"), includeIntraday: true, intradayRange: "1d", concurrency: 2 });
      await upsertQuoteBatch(db, result);
      const status = result.failures.length ? result.quotes.length ? "partial" : "failed" : "complete";
      await markRefreshJob(db, job.claimId, status);
      if (!result.quotes.length && job.securityIds.length) throw new Error(result.failures[0]?.message ?? "scheduled_quote_refresh_failed");
      return { kind: job.kind, returned: result.quotes.length, failed: result.failures.length };
    }
    if (job.kind === "history") {
      const historyResult = await fetchMarketHistoryBatch(job.securityIds);
      await upsertHistoryBatch(db, { ...historyResult, distributions: [], coveredSecurityIds: [] });
      const failures = historyResult.failures;
      const returned = historyResult.coverage.returned;
      const status = failures.length ? returned ? "partial" : "failed" : "complete";
      await markRefreshJob(db, job.claimId, status);
      if (!returned && job.securityIds.length) throw new Error(failures[0]?.message ?? "scheduled_history_refresh_failed");
      return { kind: job.kind, returned, failed: failures.length };
    }
    if (job.kind === "distributions") {
      const result = await fetchMarketHistoryBatch(job.securityIds, { from: "2000-01-01", distributionsOnly: true });
      await upsertHistoryBatch(db, result);
      const status = result.failures.length ? result.coverage.returned ? "partial" : "failed" : "complete";
      await markRefreshJob(db, job.claimId, status);
      if (!result.coverage.returned && job.securityIds.length) throw new Error(result.failures[0]?.message ?? "scheduled_distribution_refresh_failed");
      return { kind: job.kind, returned: result.coverage.returned, failed: result.failures.length };
    }
    const result = await fetchMarketBenchmarks();
    await upsertBenchmarks(db, result.benchmarks);
    await incrementDailyUsage(db, { providerCalls: 7, quoteWrites: 14, failures: result.failures.length });
    const status = result.failures.length ? result.benchmarks.length ? "partial" : "failed" : "complete";
    await markRefreshJob(db, job.claimId, status);
    if (!result.benchmarks.length) throw new Error(result.failures[0]?.message ?? "scheduled_benchmark_refresh_failed");
    return { kind: job.kind, returned: result.benchmarks.length, failed: result.failures.length };
  } catch (error) {
    await markRefreshJob(db, job.claimId, "failed").catch(() => undefined);
    throw error;
  }
}

export function isD1DailyLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:d1|database).*(?:daily|day).*(?:limit|quota)|(?:daily|day).*(?:d1|database).*(?:limit|quota)/i.test(message);
}
