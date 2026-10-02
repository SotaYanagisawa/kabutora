import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { fetchMarketBenchmarks } from "@/lib/server-market-provider";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { upsertBenchmarks } from "@/lib/server-market-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const result = await fetchMarketBenchmarks(force);
  const { db, ctx } = await getMarketCloudflareContext().catch(() => ({ db: undefined, ctx: undefined }));
  if (db) {
    const persist = upsertBenchmarks(db, result.benchmarks).catch(() => undefined);
    if (ctx) ctx.waitUntil(persist);
    else await persist;
  }
  return Response.json(result, {
    status: result.benchmarks.length ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
