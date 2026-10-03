import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server/server-auth";
import { MarketHub, MemoryMarketStore, serveMarket } from "@/lib/server/market-hub";
import { searchSecurities } from "@/lib/server/market-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Local Mac app and `next dev` only. On Cloudflare the Worker routes /api/market/* first.
const shared = globalThis as typeof globalThis & { kabutoraMarketHub?: MarketHub };
const hub = () => (shared.kabutoraMarketHub ??= new MarketHub(new MemoryMarketStore()));

async function handle(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  if (resource !== "health") {
    try {
      await authorizeMarketRequest(request, process.env, { local: Boolean(process.env.KABUTORA_LOCAL_VAULT_PATH) || process.env.NODE_ENV === "development" });
    } catch (cause) {
      return unauthorizedResponse(cause);
    }
  }
  if (resource === "search") return request.method === "POST" ? searchSecurities(request) : Response.json({ error: "method_not_allowed" }, { status: 405 });
  // The user's own machine may register every held symbol at once.
  return serveMarket(request, hub(), { maxRegister: 200 });
}

export { handle as GET, handle as POST };
