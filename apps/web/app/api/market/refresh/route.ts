import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { MARKET_D1_WRITE_BUDGET, MARKET_PROVIDER_CALL_BUDGET, MARKET_QUEUE_MESSAGE_BUDGET, normalizePublicSecurityIds, readDailyUsage } from "@/lib/server-market-store";
import type { MarketRefreshJob } from "@/lib/server-market-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
  const context=await getMarketCloudflareContext().catch(()=>({coordinator:undefined}));
  if (context.coordinator) {
    const body: unknown=await request.json().catch(()=>null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return Response.json({error:"market_refresh_public_catalog_only"},{status:400});
    const response=await context.coordinator.get(context.coordinator.idFromName("public-market-v2")).fetch("https://coordinator/refresh",{method:"POST"});
    return new Response(response.body,{status:response.ok ? 202 : response.status,headers:{"Content-Type":"application/json","Cache-Control":"private, no-store"}});
  }
  const body = await request.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid_market_refresh" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "securityIds")) {
    return Response.json({ error: "market_refresh_public_fields_only" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!Array.isArray(record.securityIds) || record.securityIds.length < 1 || record.securityIds.length > 200 || record.securityIds.some(value => typeof value !== "string" || !value.trim())) {
    return Response.json({ error: "invalid_market_security_count" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const rawIds = [...new Set(record.securityIds.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  const securities = normalizePublicSecurityIds(rawIds);
  if (securities.length !== rawIds.length) {
    return Response.json({ error: "invalid_market_security_id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const { db, queue } = await getMarketCloudflareContext().catch(() => ({ db: undefined, queue: undefined }));
  if (!db || !queue) return Response.json({ error: "market_refresh_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const usage = await readDailyUsage(db);
  if (usage.queueMessages >= MARKET_QUEUE_MESSAGE_BUDGET || usage.providerCalls >= MARKET_PROVIDER_CALL_BUDGET
    || usage.quoteWrites + usage.historyWrites >= MARKET_D1_WRITE_BUDGET) {
    return Response.json({ accepted: securities.length, queued: 0, budgetLimited: true }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  // Registry reconciliation and per-symbol job claims also exceed the HTTP CPU
  // allowance on large registries. Dispatch that work to the existing queue.
  const scheduledAt = new Date().toISOString();
  const runId = `market:dispatch:${scheduledAt}`;
  const job: MarketRefreshJob = { version: 1, kind: "manual", claimId: runId, runId, scheduledAt, securityIds: securities.map((security) => security.securityId) };
  await queue.sendBatch([{ body: job, contentType: "json" }]);
  return Response.json({ runId, accepted: securities.length, queued: 1, budgetLimited: false }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
