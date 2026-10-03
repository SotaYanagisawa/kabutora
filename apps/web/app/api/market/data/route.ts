import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { readPublicResource } from "@/lib/server/market/publisher";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    try {
        await authorizeMarketRequest(request);
    }
    catch (cause) {
        return unauthorizedResponse(cause);
    }
    const { db } = await getMarketCloudflareContext().catch(() => ({ db: undefined }));
    if (!db)
        return Response.json({ error: "market_publication_unavailable" }, { status: 503 });
    return readPublicResource(db, request);
}
