import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { normalizeRequestedSecurities } from "@/lib/market-security";
import { portfolioMarketSessions } from "@/lib/market-session";
import { fetchMarketQuoteBatch } from "@/lib/server-market-provider";
import { MARKET_PROVIDER_CALL_BUDGET, readDailyUsage, readUsIntradayBars, upsertQuoteBatch } from "@/lib/server-market-store";
import { readLatestJapannextPtsBars } from "@/lib/server-pts-collector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const US_RECOVERY_COOLDOWN_MS = 10 * 60_000;
const lastUsRecoveryAt = new Map<string, number>();

function privateHeaders(etag?: string) {
  return { "Cache-Control": "private, no-store", ...(etag ? { ETag: etag } : {}) };
}

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const url = new URL(request.url);
  const market = url.searchParams.get("market")?.toUpperCase() === "US" ? "US" : "JP";
  const requestedValues = (url.searchParams.get("securityIds") ?? "").split(",").filter(Boolean);
  if (!requestedValues.length || requestedValues.length > 20) {
    return Response.json({ error: "invalid_security_ids" }, { status: 400, headers: privateHeaders() });
  }
  const securities = normalizeRequestedSecurities(requestedValues.join(","), 20);
  const isExpectedVenue = (venueCode: string) =>
    market === "US"
      ? venueCode === "US" || venueCode === "USD_FUND" || venueCode === "INDEX"
      : venueCode === "TSE" || venueCode === "FUND";
  if (securities.length !== new Set(requestedValues).size || securities.some((security) => !isExpectedVenue(security.venueCode))) {
    return Response.json({ error: "invalid_security_ids" }, { status: 400, headers: privateHeaders() });
  }
  const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
  if (!db) {
    if (market === "US") {
      try {
        const batchResult = await fetchMarketQuoteBatch(securities.map((s) => s.id), { includeIntraday: true, intradayRange: "5d", concurrency: 4 });
        return Response.json({
          generatedAt: new Date().toISOString(),
          market: "US",
          bars: batchResult.intraday,
          sessions: [],
          coverage: {
            requested: securities.length,
            ready: batchResult.intraday.length ? securities.length : 0,
            currentReady: batchResult.intraday.length ? securities.length : 0,
          },
          revision: new Date().toISOString(),
        }, { headers: privateHeaders() });
      } catch {
        return Response.json({ error: "market_intraday_unavailable" }, { status: 503, headers: privateHeaders() });
      }
    }
    if (market === "JP") {
      return Response.json({
        generatedAt: new Date().toISOString(),
        market: "JP",
        bars: [],
        nextCursor: null,
      }, { headers: privateHeaders() });
    }
    return Response.json({ error: "market_intraday_unavailable" }, { status: 503, headers: privateHeaders() });
  }
  try {
    if (market === "JP") {
      const ids = new Set(securities.map((security) => `sec-${security.displaySymbol.toLowerCase()}`));
      const cursor = url.searchParams.get("cursor");
      const result = await readLatestJapannextPtsBars(db, ids, cursor);
      return Response.json({ generatedAt: new Date().toISOString(), bars: result.bars, nextCursor: result.revision }, { headers: privateHeaders() });
    }

    let result = await readUsIntradayBars(db, securities.map((security) => security.id));
    const now = Date.now();
    const recoveryRequested = url.searchParams.get("recover") === "1";
    const completelyMissingIds = securities
      .filter((security) => {
        const canonical = `sec-us-${security.displaySymbol.toLowerCase()}`;
        return !result.bars.some((b) => b.securityId === security.id || b.securityId === canonical);
      })
      .map((security) => security.id);
    const cooldownEligible = result.missingCurrentSecurityIds.filter((securityId) => now - (lastUsRecoveryAt.get(securityId) ?? 0) >= US_RECOVERY_COOLDOWN_MS);
    const targetRecoveryIds = [...new Set([...completelyMissingIds, ...(recoveryRequested ? cooldownEligible : [])])];

    if (targetRecoveryIds.length) {
      const usage = await readDailyUsage(db);
      if (usage.providerCalls + targetRecoveryIds.length <= MARKET_PROVIDER_CALL_BUDGET) {
        targetRecoveryIds.forEach((securityId) => lastUsRecoveryAt.set(securityId, now));
        const recovered = await fetchMarketQuoteBatch(targetRecoveryIds, { includeIntraday: true, intradayRange: "5d", concurrency: 4 });
        await upsertQuoteBatch(db, recovered);
        result = await readUsIntradayBars(db, securities.map((security) => security.id));
      }
    }
    const sessionKey = result.sessions
      .map((s) => `${s.securityId}:${s.currentSessionDate}:${s.currentPoints}:${s.previousSessionDate}:${s.previousPoints}:${s.ready ? 1 : 0}`)
      .join(";");
    const etag = `"us-intraday-${result.revision ?? "empty"}-${result.bars.length}-${sessionKey}"`;
    if (!recoveryRequested && request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: privateHeaders(etag) });
    }
    return Response.json({
      generatedAt: new Date().toISOString(),
      market: "US",
      bars: result.bars,
      sessions: result.sessions,
      coverage: {
        requested: securities.length,
        ready: result.sessions.filter((session) => session.ready).length,
        currentReady: result.sessions.filter((session) => session.currentPoints >= 2).length,
      },
      revision: result.revision,
    }, { headers: privateHeaders(etag) });
  } catch {
    return Response.json({ error: "market_intraday_unavailable" }, { status: 503, headers: privateHeaders() });
  }
}
