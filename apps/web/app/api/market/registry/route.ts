import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { mergeMarketSecurities, normalizePublicSecurityIds, reconcileMarketSecurities } from "@/lib/server-market-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid_market_registry" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "securityIds" && key !== "mode")) {
    return Response.json({ error: "market_registry_public_fields_only" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!Array.isArray(record.securityIds) || record.securityIds.length < 1 || record.securityIds.length > 250) {
    return Response.json({ error: "invalid_market_security_count" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const securities = normalizePublicSecurityIds(record.securityIds);
  if (securities.length !== new Set(record.securityIds.filter((value): value is string => typeof value === "string").map((value) => value.trim())).size) {
    return Response.json({ error: "invalid_market_security_id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
  if (!db) return Response.json({ error: "market_registry_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const mode = record.mode === "reconcile" ? "reconcile" : record.mode === "merge" || record.mode == null ? "merge" : null;
  if (!mode) return Response.json({ error: "invalid_market_registry_mode" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const registered = mode === "reconcile"
    ? await reconcileMarketSecurities(db, securities)
    : await mergeMarketSecurities(db, securities);
  return Response.json({ registered, mode, updatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
