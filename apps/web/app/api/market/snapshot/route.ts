import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { readMarketSnapshot } from "@/lib/server-market-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
  if (!db) return Response.json({ error: "market_snapshot_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  const includeIntraday = new URL(request.url).searchParams.get("intraday") !== "0";
  try {
    const snapshot = await readMarketSnapshot(db, includeIntraday);
    const intradayVersion = includeIntraday ? snapshot.intradayRevision ?? "none" : "compact";
    const etag = `W/"market-${includeIntraday ? "full" : "compact"}-${snapshot.savedAt ?? "empty"}-${intradayVersion}-${snapshot.coverage.quoted}-${snapshot.coverage.registered}"`;
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
    }
    return Response.json(snapshot, {
      status: 200,
      headers: { ETag: etag, "Cache-Control": "private, no-store" },
    });
  } catch {
    return Response.json({ error: "market_snapshot_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
