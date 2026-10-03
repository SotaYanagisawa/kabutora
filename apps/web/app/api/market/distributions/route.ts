import type { CorporateAction, DistributionEvent } from "@kabutora/domain";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { fetchMarketHistoryBatch } from "@/lib/server-market-provider";
import { mergeMarketSecurities, normalizePublicSecurityIds, readCachedDistributions, upsertHistoryBatch } from "@/lib/server-market-store";
import type { DistributionCoverage, MarketDistributionBatchResult } from "@/lib/server-market-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISTRIBUTION_HISTORY_FROM = "2000-01-01";
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MANUAL_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function coverageByCanonical(items: DistributionCoverage[]) {
  return new Map(items.map((item) => [canonicalDomainSecurityId(item.securityId), item]));
}

function directCoverage(
  securityIds: string[],
  distributions: DistributionEvent[],
  actions: CorporateAction[],
  generatedAt: string,
): DistributionCoverage[] {
  return securityIds.map((securityId) => {
    const events = distributions.filter((event) => canonicalDomainSecurityId(event.securityId) === canonicalDomainSecurityId(securityId));
    const positiveEvents = events.filter((event) => Number(event.amountPerUnit) > 0);
    const sourceProvider = positiveEvents[0]?.sourceProvider ?? actions.find((action) => canonicalDomainSecurityId(action.securityId) === canonicalDomainSecurityId(securityId))?.sourceProvider;
    return {
      securityId,
      coveredFrom: DISTRIBUTION_HISTORY_FROM,
      checkedThrough: generatedAt.slice(0, 10),
      checkedAt: generatedAt,
      eventCount: positiveEvents.length,
      status: positiveEvents.length ? "ready" : "no_events",
      ...(sourceProvider ? { sourceProvider } : {}),
    };
  });
}

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
  const body = await request.json().catch(() => ({})) as { refresh?: unknown; securityIds?: unknown };
  const requestedIds = typeof body.securityIds === "string"
    ? body.securityIds.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const securities = normalizePublicSecurityIds(requestedIds);
  const securityIds = securities.map((security) => security.securityId);
  const force = body.refresh === true;
  const marketContext = await getMarketCloudflareContext().catch(() => ({ db: undefined, ctx: undefined }));
  let cached = { distributions: [] as DistributionEvent[], corporateActions: [] as CorporateAction[], coverage: [] as DistributionCoverage[] };

  if (marketContext.db) {
    try { cached = await readCachedDistributions(marketContext.db, securityIds); } catch { /* A missing coverage migration falls through to providers. */ }
  }
  const cachedCoverage = coverageByCanonical(cached.coverage);
  const now = Date.now();
  const refreshIds = securityIds.filter((securityId) => {
    const coverage = cachedCoverage.get(canonicalDomainSecurityId(securityId));
    if (!coverage) return true;
    const age = now - Date.parse(coverage.checkedAt);
    if (force) return !Number.isFinite(age) || age >= MANUAL_REFRESH_COOLDOWN_MS;
    return coverage.coveredFrom > DISTRIBUTION_HISTORY_FROM || !Number.isFinite(age) || age >= FRESH_MS || coverage.status === "partial" || coverage.status === "error";
  });

  let liveResult: Awaited<ReturnType<typeof fetchMarketHistoryBatch>> | null = null;
  if (refreshIds.length) {
    liveResult = await fetchMarketHistoryBatch(refreshIds, { from: DISTRIBUTION_HISTORY_FROM, force, distributionsOnly: true });
    if (marketContext.db) {
      const persist = mergeMarketSecurities(marketContext.db, securities.filter((security) => refreshIds.includes(security.securityId)))
        .then(() => upsertHistoryBatch(marketContext.db!, liveResult!))
        .catch(() => undefined);
      if (marketContext.ctx) marketContext.ctx.waitUntil(persist);
      else await persist;
    }
  }

  let stored = cached;
  if (marketContext.db && liveResult) {
    try { stored = await readCachedDistributions(marketContext.db, securityIds); } catch { /* Return direct provider data below. */ }
  }
  const distributions = [...new Map([
    ...stored.distributions,
    ...(liveResult?.distributions ?? []),
  ].map((event) => [event.id, event])).values()];
  const corporateActions = [...new Map([
    ...stored.corporateActions,
    ...(liveResult?.corporateActions ?? []),
  ].map((action) => [action.id, action])).values()];
  const generatedAt = liveResult?.generatedAt ?? new Date().toISOString();
  const direct = liveResult ? directCoverage(liveResult.coveredSecurityIds, liveResult.distributions, liveResult.corporateActions, generatedAt) : [];
  const coverageMap = coverageByCanonical([...stored.coverage, ...direct]);
  const failedIds = new Set(liveResult?.failures.map((failure) => canonicalDomainSecurityId(failure.securityId)) ?? []);
  const coverage = securityIds.map((securityId): DistributionCoverage => {
    const key = canonicalDomainSecurityId(securityId);
    const item = coverageMap.get(key);
    if (item && !failedIds.has(key)) return item;
    if (item) {
      const age = now - Date.parse(item.checkedAt);
      return { ...item, status: Number.isFinite(age) && age <= STALE_FALLBACK_MS ? "partial" : "error" };
    }
    return {
      securityId,
      coveredFrom: DISTRIBUTION_HISTORY_FROM,
      checkedThrough: generatedAt.slice(0, 10),
      checkedAt: generatedAt,
      eventCount: 0,
      status: "error",
    };
  });
  const payload: MarketDistributionBatchResult = {
    generatedAt,
    distributions,
    corporateActions,
    coverage,
    failures: liveResult?.failures ?? [],
  };
  const usable = coverage.some((item) => item.status === "ready" || item.status === "no_events" || item.status === "partial");
  return Response.json(payload, {
    status: usable || securityIds.length === 0 ? 200 : 503,
    headers: { "Cache-Control": "private, no-store" },
  });
}
