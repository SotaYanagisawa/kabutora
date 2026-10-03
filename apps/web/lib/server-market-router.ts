import { GET as data } from "../app/api/market/data/route";
import { GET as progress } from "../app/api/market/progress/route";
import { GET as status } from "../app/api/market/status/route";
import { GET as benchmarks } from "../app/api/market/benchmarks/route";
import { POST as distributions } from "../app/api/market/distributions/route";
import { POST as history } from "../app/api/market/history/route";
import { GET as intraday } from "../app/api/market/intraday/route";
import { POST as quotes } from "../app/api/market/quotes/route";
import { POST as refresh } from "../app/api/market/refresh/route";
import { POST as registry } from "../app/api/market/registry/route";
import { POST as search } from "../app/api/market/search/route";
import { GET as snapshot } from "../app/api/market/snapshot/route";
import { withMarketRequestContext, type MarketRequestContext } from "./server-market-request-context";
import { authorizeMarketRequest, unauthorizedResponse } from "./server-auth";

const routes: Record<string, { method: string; handle: (request: Request) => Promise<Response> }> = {
  data: { method:"GET",handle:data },
  progress: { method:"GET",handle:progress },
  status: { method:"GET",handle:status },
  benchmarks: { method: "GET", handle: benchmarks },
  distributions: { method: "POST", handle: distributions },
  history: { method: "POST", handle: history },
  intraday: { method: "GET", handle: intraday },
  quotes: { method: "POST", handle: quotes },
  refresh: { method: "POST", handle: refresh },
  registry: { method: "POST", handle: registry },
  search: { method: "POST", handle: search },
  snapshot: { method: "GET", handle: snapshot },
};

/** JSON endpoints do not need the Next.js rendering/request-adapter pipeline. */
export async function routeMarketRequest(request: Request, context: MarketRequestContext): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/api/market/")) return null;
  const name = pathname.slice("/api/market/".length);
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  let response: Response;
  if (!route) {
    response = Response.json({ error: "not_found" }, { status: 404 });
  } else if (request.method !== route.method) {
    response = Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: route.method } });
  } else {
    try {
      response = await withMarketRequestContext(context, async () => {
        if (context.env.KABUTORA_MARKET_BACKEND === "v2" && ["quotes", "benchmarks", "history", "distributions", "intraday"].includes(name)) {
          try { await authorizeMarketRequest(request); } catch (cause) { return unauthorizedResponse(cause); }
          return Response.json({ error: "market_client_upgrade_required" }, { status: 409 });
        }
        return route.handle(request);
      });
    } catch (error) {
      console.error("market_route_unavailable");
      response = Response.json({ error: "market_request_unavailable" }, { status: 503 });
    }
  }
  // Keep the security headers otherwise applied by Next's headers() config.
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return new Response(response.status === 204 || response.status === 304 ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
