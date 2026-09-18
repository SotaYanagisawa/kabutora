import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { readMarketSnapshot } from "@/lib/server-market-store";
import { marketSnapshotEtag, readPreparedMarketSnapshot } from "@/lib/server-market-response-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
  if (!db) return Response.json({ error: "market_snapshot_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  const includeIntraday = new URL(request.url).searchParams.get("intraday") !== "0";
  const prepared = await readPreparedMarketSnapshot(db, request, includeIntraday).catch(() => null);
  if (prepared) return prepared;
  try {
    const snapshot = await readMarketSnapshot(db, includeIntraday);
    const etag = marketSnapshotEtag(snapshot, includeIntraday);
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
