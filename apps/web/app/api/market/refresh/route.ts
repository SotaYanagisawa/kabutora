import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { enqueueManualMarketRefresh } from "@/lib/server-market-scheduler";
import { mergeMarketSecurities, normalizePublicSecurityIds } from "@/lib/server-market-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid_market_refresh" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "securityIds")) {
    return Response.json({ error: "market_refresh_public_fields_only" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!Array.isArray(record.securityIds) || record.securityIds.length < 1 || record.securityIds.length > 200) {
    return Response.json({ error: "invalid_market_security_count" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const rawIds = [...new Set(record.securityIds.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  const securities = normalizePublicSecurityIds(rawIds);
  if (securities.length !== rawIds.length) {
    return Response.json({ error: "invalid_market_security_id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const { db, queue } = await getMarketCloudflareContext().catch(() => ({ db: undefined, queue: undefined }));
  if (!db || !queue) return Response.json({ error: "market_refresh_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  await mergeMarketSecurities(db, securities);
  const result = await enqueueManualMarketRefresh(db, queue, securities.map((security) => security.securityId));
  return Response.json(result, { status: result.budgetLimited && result.queued === 0 ? 429 : 202, headers: { "Cache-Control": "no-store" } });
}
