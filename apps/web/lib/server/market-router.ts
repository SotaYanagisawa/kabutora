import { authorizeMarketRequest, unauthorizedResponse } from "./server-auth";
import { searchSecurities } from "./market-search";
import { marketStub, type MarketWorkerEnv } from "./market-object";

const ROUTES: Record<string, "GET" | "POST"> = {
  snapshot: "GET",
  history: "GET",
  distributions: "GET",
  registry: "POST",
  search: "POST",
  health: "GET",
};

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

async function dispatch(request: Request, env: MarketWorkerEnv, name: string): Promise<Response> {
  const method = Object.hasOwn(ROUTES, name) ? ROUTES[name] : undefined;
  if (!method) return Response.json({ error: "not_found" }, { status: 404 });
  if (request.method !== method) return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: method } });
  if (name !== "health") {
    try {
      await authorizeMarketRequest(request, env);
    } catch (cause) {
      return unauthorizedResponse(cause);
    }
  }
  try {
    return name === "search" ? await searchSecurities(request) : await marketStub(env).fetch(request);
  } catch {
    console.error("market_route_unavailable", name);
    return Response.json({ error: "market_unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
  }
}

/** Native Worker routing for /api/market/*: auth, then the market object. No Next.js, no D1. */
export async function routeMarketRequest(request: Request, env: MarketWorkerEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/market/")) return null;
  const response = await dispatch(request, env, pathname.slice("/api/market/".length));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return new Response(response.status === 304 ? null : response.body, { status: response.status, headers });
}
