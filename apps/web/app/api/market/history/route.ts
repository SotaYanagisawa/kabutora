import { canonicalDomainSecurityId } from "@kabutora/domain";
import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { fetchMarketHistoryBatch } from "@/lib/server-market-provider";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { mergeMarketSecurities, normalizePublicSecurityIds, readCachedHistory, upsertHistoryBatch } from "@/lib/server-market-store";
import { inspectMarketHistory } from "@/lib/market-history";
import { firstInternalHistoryGap, MAX_EXPECTED_MARKET_GAP_DAYS } from "@/lib/market-fetch-plan";
import { japanTradingDateForSparkline, portfolioMarketSessions, usTradingDateForSparkline } from "@/lib/market-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
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
      const latestBySecurity = new Map<string, string>();
      for (const bar of cached.bars) {
        const earliest = earliestBySecurity.get(bar.securityId);
        if (!earliest || bar.date < earliest) earliestBySecurity.set(bar.securityId, bar.date);
        const latest = latestBySecurity.get(bar.securityId);
        if (!latest || bar.date > latest) latestBySecurity.set(bar.securityId, bar.date);
      }

      const now = new Date();
      const todayIso = now.toISOString().slice(0, 10);
      const expectedLatestTradingDate = (venueCode: string, currency: string) => {
        if (venueCode === "US" || venueCode === "USD_FUND" || venueCode === "INDEX") {
          return usTradingDateForSparkline(now);
        }
        if (venueCode === "TSE" || venueCode === "FUND") {
          return japanTradingDateForSparkline(now);
        }
        return currency === "USD" ? usTradingDateForSparkline(now) : japanTradingDateForSparkline(now);
      };

      const cachedIdsSet = new Set(cached.cachedSecurityIds);
      const satisfiedIds = new Set<string>();
      const missingIds: string[] = [];

      for (const security of normalizedSecurities) {
        const securityId = security.securityId;
        const earliest = earliestBySecurity.get(securityId);
        const latest = latestBySecurity.get(securityId);
        const inception = cached.inceptionDates[securityId];
        const coversStart = !requestedFrom || Boolean(earliest && (earliest <= requestedFrom || (inception && inception >= requestedFrom)));
        const expectedDate = expectedLatestTradingDate(security.venueCode, security.currency);
        const coversEnd = Boolean(latest && latest >= expectedDate);
        const hasGap = Boolean(firstInternalHistoryGap(cached.bars, securityId, requestedFrom ?? earliest ?? todayIso, MAX_EXPECTED_MARKET_GAP_DAYS, expectedDate));
        if (cachedIdsSet.has(securityId) && coversStart && coversEnd && !hasGap) {
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

      if (missingIds.length > 0) {
        const missingResult = await fetchMarketHistoryBatch(missingIds, {
          force: false,
          from: requestedFrom ?? undefined,
        });

        const persist = mergeMarketSecurities(marketContext.db, normalizePublicSecurityIds(missingIds))
          .then(() => upsertHistoryBatch(marketContext.db!, { ...missingResult, distributions: [], coveredSecurityIds: [] }))
          .catch(() => undefined);
        if (marketContext.ctx) marketContext.ctx.waitUntil(persist);
        else await persist;

        const inspected = inspectMarketHistory(cached.bars, missingResult.bars, [...cached.corporateActions, ...missingResult.corporateActions]);
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
          provider: { primary: satisfiedIds.size > 0 ? "d1_and_provider_hybrid" : "yahoo_and_monex_unofficial", status: missingResult.failures.length ? "partial" : "ok" },
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
