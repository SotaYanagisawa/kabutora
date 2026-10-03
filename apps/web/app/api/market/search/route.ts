import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { parseYahooJapanFundSearch, type YahooJapanFundSearchResult } from "@/lib/yahoo-japan-fund";
import { searchKnownJapanFunds } from "@/lib/japan-fund-catalog";
import { searchEmbeddedCatalog } from "@/lib/stock-catalog";
import { normalizeYahooGlobalQuote } from "@/lib/global-security";
import type { YahooUsdSearchQuote } from "@/lib/usd-security";
import { stableMarketErrorMessage } from "@/lib/market-api-response";
import { searchProviderPlan } from "@/lib/market-search-plan";
import { getMarketCloudflareContext } from "@/lib/cloudflare-market-env";
import { providerFetch, withProviderExecution } from "@/lib/server/market/provider-fetch";
import { currentMarketRequestContext } from "@/lib/server-market-request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { CatalogSecurity } from "@/lib/stock-catalog";

type YahooSearchPayload = { quotes?: YahooUsdSearchQuote[] };
type SearchResult =
  | NonNullable<ReturnType<typeof normalizeJapaneseQuote>>
  | NonNullable<ReturnType<typeof normalizeYahooGlobalQuote>>
  | YahooJapanFundSearchResult
  | CatalogSecurity;

const searchCache = new Map<string, { expiresAt: number; results: SearchResult[]; warnings: string[] }>();
const searchInFlight = new Map<string, Promise<{ results: SearchResult[]; warnings: string[] }>>();
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeJapaneseQuote(quote: YahooUsdSearchQuote) {
  const providerSymbol = (quote.symbol ?? "").toUpperCase();
  const sourceName = quote.longname ?? quote.shortname ?? providerSymbol;
  if (!providerSymbol || !sourceName || !["EQUITY", "ETF"].includes(quote.quoteType ?? "")) return null;

  if (/^[0-9]{4}\.T$/u.test(providerSymbol) || /^[0-9]{3}[A-Z]\.T$/u.test(providerSymbol)) {
    const displaySymbol = providerSymbol.slice(0, -2);
    return {
      id: `sec-${displaySymbol.toLowerCase()}-xtks`,
      displaySymbol,
      name: sourceName.replace(/^\(株\)/u, "").replace(/\(株\)$/u, ""),
      assetType: "stock" as const,
      country: "JP" as const,
      exchangeMic: "XTKS",
      currency: "JPY",
      providerSymbols: { yahoo: providerSymbol },
      exchangeLabel: "東証",
    };
  }

  return null;
}

function providerSignal(parent: AbortSignal, timeoutMs: number) {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

async function searchYahooGlobal(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const failures: string[] = [];
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      const url = new URL(`https://${host}/v1/finance/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("quotesCount", "15");
      url.searchParams.set("newsCount", "0");
      url.searchParams.set("listsCount", "0");
      const response = await providerFetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", "User-Agent": "Kabutora/1.0 personal-portfolio-tracker" },
        signal: providerSignal(signal, 1_800),
      });
      if (!response.ok) throw new Error(`${host} returned ${response.status}`);
      const payload = (await response.json()) as YahooSearchPayload;
      return (payload.quotes ?? [])
        .map((quote) => normalizeJapaneseQuote(quote) ?? normalizeYahooGlobalQuote(quote))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join("; ") || "Global search unavailable");
}

async function searchYahooJapan(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("https://finance.yahoo.co.jp/search/");
  url.searchParams.set("query", query);
  const response = await providerFetch(url, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
    signal: providerSignal(signal, 2_000),
  });
  if (!response.ok) throw new Error(`Yahoo Japan returned ${response.status}`);
  const html = await response.text();
  const expression = /"detailLink":"https:\/\/finance\.yahoo\.co\.jp\/quote\/([0-9]{4}|[0-9]{3}[A-Z])\.T","code":"[^"]+","marketName":"([^"]+)","name":"([^"]+)"/gu;
  const results: SearchResult[] = [];
  for (const match of html.matchAll(expression)) {
    if (!match[2].startsWith("東証")) continue;
    const displaySymbol = match[1];
    const name = match[3].replace(/^\(株\)/u, "").replace(/\(株\)$/u, "");
    results.push({
      id: `sec-${displaySymbol.toLowerCase()}-xtks`,
      displaySymbol,
      name,
      assetType: "stock" as const,
      country: "JP" as const,
      exchangeMic: "XTKS",
      currency: "JPY",
      providerSymbols: { yahoo: `${displaySymbol}.T` },
      exchangeLabel: match[2],
    });
  }
  return [...parseYahooJapanFundSearch(html), ...results];
}

export async function POST(request: Request) {
  try {
    await authorizeMarketRequest(request);
  } catch (cause) {
    return unauthorizedResponse(cause);
  }
  const body = (await request.json().catch(() => ({}))) as { q?: unknown };
  const query = typeof body.q === "string" ? body.q.trim() : "";
  if (!query || query.length > 96) return Response.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });

  const key = query.toLocaleLowerCase("en-US");
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(
      { results: cached.results, provider: "normalized_search_cache", ...(cached.warnings.length ? { warnings: cached.warnings } : {}) },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  }

  let task = searchInFlight.get(key);
  if (!task) {
    if (searchInFlight.size >= 32) return Response.json({ results: [], error: "search_busy" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
    const work = async () => {
      const catalogResults = searchKnownJapanFunds(query);
      const stockResults = searchEmbeddedCatalog(query);
      const combinedLocal = [...new Map([...catalogResults, ...stockResults].map((item) => [item.id, item])).values()];
      if (combinedLocal.length >= 10) return { results: combinedLocal.slice(0, 15), warnings: [] };

      const providerPlan = searchProviderPlan(query);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new DOMException("Search deadline exceeded", "TimeoutError")), 2_300);
      const providers: Array<Promise<SearchResult[]>> = providerPlan === "japan"
        ? [searchYahooJapan(query, controller.signal)]
        : providerPlan === "global"
          ? [searchYahooGlobal(query, controller.signal)]
          : [searchYahooJapan(query, controller.signal), searchYahooGlobal(query, controller.signal)];
      const warnings: string[] = [];
      let providerResults: SearchResult[] = [];
      try {
        const settled = await Promise.allSettled(providers);
        for (const res of settled) {
          if (res.status === "fulfilled" && res.value.length) {
            providerResults.push(...res.value);
          } else if (res.status === "rejected") {
            warnings.push(stableMarketErrorMessage(res.reason, "一部の検索先から応答がありませんでした"));
          }
        }
      } catch (error) {
        warnings.push(stableMarketErrorMessage(error, "検索先から応答がありませんでした"));
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
      const results = [...new Map([...combinedLocal, ...providerResults].map((item) => [item.id, item])).values()].slice(0, 15);
      if (results.length) {
        if (searchCache.size >= 200) searchCache.delete(searchCache.keys().next().value!);
        searchCache.set(key, { expiresAt: Date.now() + SEARCH_TTL_MS, results, warnings });
      }
      return { results, warnings };
    };
    task = (async () => {
      if (currentMarketRequestContext()?.env.KABUTORA_MARKET_BACKEND !== "v2" && process.env.NEXT_PUBLIC_KABUTORA_MARKET_BACKEND !== "v2") return work();
      const { coordinator } = await getMarketCloudflareContext();
      if (!coordinator) throw new Error("market_coordinator_unavailable");
      const stub = coordinator.get(coordinator.idFromName("public-market-v2"));
      const report = async (path: string, body: object) => {
        const response = await stub.fetch(`https://coordinator.internal/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("provider_budget_unavailable");
      };
      return withProviderExecution({ signal: AbortSignal.timeout(8000), reserve: (host) => report("provider-reservation", { host }), outcome: (host, status) => report("provider-outcome", { host, status }) }, work);
    })();
    searchInFlight.set(key, task);
  }
  try {
    const { results, warnings } = await task;
    return Response.json(
      { results, provider: "yahoo_japan_and_global_search_unofficial", ...(warnings.length ? { warnings } : {}) },
      { status: results.length || !warnings.length ? 200 : 503, headers: { "Cache-Control": "private, max-age=300" } },
    );
  } finally {
    searchInFlight.delete(key);
  }
}
