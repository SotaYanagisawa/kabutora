import { canonicalDomainSecurityId } from "@kabutora/domain";
import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { fetchMarketHistoryBatch } from "@/lib/server-market-provider";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { mergeMarketSecurities, normalizePublicSecurityIds, readCachedHistory, upsertHistoryBatch } from "@/lib/server-market-store";
import { inspectMarketHistory } from "@/lib/market-history";
import { portfolioMarketSessions } from "@/lib/market-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => ({})) as { refresh?: unknown; securityIds?: unknown; from?: unknown };
  const securityIds = typeof body.securityIds === "string" ? body.securityIds.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const requestedFrom = typeof body.from === "string" && /^20\d{2}-\d{2}-\d{2}$/u.test(body.from) ? body.from : null;
  const marketContext = await getMarketCloudflareContext().catch(() => ({ db: undefined, ctx: undefined }));
  if (body.refresh !== true && marketContext.db && securityIds.length > 0) {
    try {
      const normalizedSecurities = normalizePublicSecurityIds(securityIds);
      const normalizedIds = normalizedSecurities.map((security) => security.securityId);
      const cached = await readCachedHistory(marketContext.db, normalizedIds);
      const earliestBySecurity = new Map<string, string>();
      for (const bar of cached.bars) {
        const earliest = earliestBySecurity.get(bar.securityId);
        if (!earliest || bar.date < earliest) earliestBySecurity.set(bar.securityId, bar.date);
      }

      const cachedIdsSet = new Set(cached.cachedSecurityIds);
      const satisfiedIds = new Set<string>();
      const missingIds: string[] = [];

      for (const securityId of normalizedIds) {
        const earliest = earliestBySecurity.get(securityId);
        const inception = cached.inceptionDates[securityId];
        const coversRange = !requestedFrom || Boolean(earliest && (earliest <= requestedFrom || (inception && inception >= requestedFrom)));
        if (cachedIdsSet.has(securityId) && coversRange) {
          satisfiedIds.add(securityId);
        } else {
          missingIds.push(securityId);
        }
      }

      if (satisfiedIds.size === normalizedIds.length && normalizedIds.length > 0) {
        const inspected = inspectMarketHistory([], cached.bars, cached.corporateActions);
        if (marketContext.db && (inspected.quality.repairedBars ?? 0) > 0) {
          const persist = upsertHistoryBatch(marketContext.db, {
            generatedAt: new Date().toISOString(),
            requestedFrom: requestedFrom ?? "",
            marketSessions: [],
            bars: inspected.bars,
            corporateActions: inspected.actions,
            distributions: [],
            inceptionDates: cached.inceptionDates,
            quality: inspected.quality,
            failures: [],
            coverage: { requested: normalizedIds.length, returned: normalizedIds.length },
            coveredSecurityIds: [...satisfiedIds],
          }).catch(() => undefined);
          if (marketContext.ctx) marketContext.ctx.waitUntil(persist);
          else await persist;
        }
        const generatedAt = new Date().toISOString();
        return Response.json({
          generatedAt,
          marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
          bars: inspected.bars,
          corporateActions: inspected.actions,
          inceptionDates: cached.inceptionDates,
          quality: inspected.quality,
          failures: [],
          coverage: { requested: normalizedIds.length, returned: normalizedIds.length },
          provider: { primary: "server_market_snapshot", status: "ok" },
        }, { headers: { "Cache-Control": "private, no-store", "X-History-Checksum": inspected.quality.checksum } });
      }

      if (satisfiedIds.size > 0 && missingIds.length > 0) {
        const missingResult = await fetchMarketHistoryBatch(missingIds, {
          force: false,
          from: requestedFrom ?? undefined,
        });

        const persist = mergeMarketSecurities(marketContext.db, normalizePublicSecurityIds(missingIds))
          .then(() => upsertHistoryBatch(marketContext.db!, { ...missingResult, distributions: [], coveredSecurityIds: [] }))
          .catch(() => undefined);
        if (marketContext.ctx) marketContext.ctx.waitUntil(persist);
        else await persist;

        const cachedBarsToKeep = cached.bars.filter((bar) => satisfiedIds.has(bar.securityId));
        const cachedActionsToKeep = cached.corporateActions.filter((action) => satisfiedIds.has(action.securityId));
        const inspected = inspectMarketHistory(cachedBarsToKeep, missingResult.bars, [...cachedActionsToKeep, ...missingResult.corporateActions]);
        const combinedInceptionDates = { ...cached.inceptionDates, ...missingResult.inceptionDates };
        const generatedAt = new Date().toISOString();
        const returnedCount = satisfiedIds.size + missingResult.coverage.returned;

        return Response.json({
          generatedAt,
          marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
          bars: inspected.bars,
          corporateActions: inspected.actions,
          inceptionDates: combinedInceptionDates,
          quality: inspected.quality,
          failures: missingResult.failures,
          coverage: { requested: normalizedIds.length, returned: returnedCount },
          provider: { primary: "d1_and_provider_hybrid", status: missingResult.failures.length ? "partial" : "ok" },
        }, { headers: { "Cache-Control": "private, no-store", "X-History-Checksum": inspected.quality.checksum } });
      }
    } catch { /* A missing/corrupt local cache falls through to the provider and is repaired asynchronously. */ }
  }
  const result = await fetchMarketHistoryBatch(securityIds, {
    force: body.refresh === true,
    from: requestedFrom ?? undefined,
  });
  if (marketContext.db) {
    const persist = mergeMarketSecurities(marketContext.db, normalizePublicSecurityIds(securityIds))
      .then(() => upsertHistoryBatch(marketContext.db!, { ...result, distributions: [], coveredSecurityIds: [] }))
      .catch(() => undefined);
    if (marketContext.ctx) marketContext.ctx.waitUntil(persist);
    else await persist;
  }
  const { distributions: _opportunisticallyPersistedDistributions, ...historyResult } = result;
  return Response.json(
    {
      ...historyResult,
      provider: { primary: "yahoo_and_monex_unofficial", status: result.failures.length ? (result.coverage.returned ? "partial" : "unavailable") : "ok" },
    },
    {
      status: result.coverage.returned || securityIds.length === 0 ? 200 : 503,
      headers: { "Cache-Control": "private, no-store", "X-History-Checksum": result.quality.checksum },
    },
  );
}
