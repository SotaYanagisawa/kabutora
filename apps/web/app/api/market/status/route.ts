import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
  const { coordinator } = await getMarketCloudflareContext().catch(() => ({ coordinator: undefined }));
  if (!coordinator) return Response.json({error:"market_coordinator_unavailable"},{status:503});
  return coordinator.get(coordinator.idFromName("public-market-v2")).fetch("https://coordinator/status");
}
