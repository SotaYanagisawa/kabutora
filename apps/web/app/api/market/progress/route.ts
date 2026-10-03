import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    try {
        await authorizeMarketRequest(request);
    }
    catch (cause) {
        return unauthorizedResponse(cause);
    }
    const runId = new URL(request.url).searchParams.get("runId") ?? "";
    if (!/^market:[a-z0-9:.-]{1,120}$/iu.test(runId))
        return Response.json({ error: "invalid_market_run" }, { status: 400 });
    const { coordinator } = await getMarketCloudflareContext().catch(() => ({ coordinator: undefined }));
    if (!coordinator)
        return Response.json({ error: "market_progress_unavailable" }, { status: 503 });
    const response = await coordinator.get(coordinator.idFromName("public-market-v2")).fetch(`https://coordinator/progress?runId=${encodeURIComponent(runId)}`);
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
