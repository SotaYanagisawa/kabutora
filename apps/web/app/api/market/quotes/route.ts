import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { fetchMarketQuoteBatch } from "@/lib/server-market-provider";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { upsertQuoteBatch } from "@/lib/server-market-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => ({})) as { refresh?: unknown; refreshSecurityIds?: unknown; includeIntraday?: unknown; intradayRange?: unknown; securityIds?: unknown };
  const securityIds = typeof body.securityIds === "string" ? body.securityIds.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const refreshIds = new Set(typeof body.refreshSecurityIds === "string" ? body.refreshSecurityIds.split(",").map((value) => value.trim()).filter(Boolean) : []);
  const result = await fetchMarketQuoteBatch(securityIds, {
    force: body.refresh === true,
    forceSecurityIds: refreshIds,
    includeIntraday: body.includeIntraday === true,
    intradayRange: body.intradayRange === "5d" ? "5d" : "1d",
  });
  const { db, ctx } = await getMarketCloudflareContext().catch(() => ({ db: undefined, ctx: undefined }));
  if (db) {
    const persist = upsertQuoteBatch(db, result).catch(() => undefined);
    if (ctx) ctx.waitUntil(persist);
    else await persist;
  }
  return Response.json(
    {
      ...result,
      provider: { primary: "yahoo_and_monex_unofficial", status: result.failures.length || result.coverage.suspect ? (result.quotes.length ? "partial" : "unavailable") : "ok" },
    },
    { status: result.quotes.length || securityIds.length === 0 ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
