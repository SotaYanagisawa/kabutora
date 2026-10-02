import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { readPreparedMarketSnapshot } from "@/lib/server-market-response-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
  const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
  if (!db) return Response.json({ error: "market_snapshot_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  const includeIntraday = new URL(request.url).searchParams.get("intraday") !== "0";
  const prepared = await readPreparedMarketSnapshot(db, request, includeIntraday).catch(() => null);
  if (prepared) return prepared;
  return Response.json({ error: "market_snapshot_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "30" } });
}
