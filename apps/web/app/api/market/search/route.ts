import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { parseYahooJapanFundSearch, type YahooJapanFundSearchResult } from "@/lib/yahoo-japan-fund";
import { searchKnownJapanFunds } from "@/lib/japan-fund-catalog";
import { normalizeYahooGlobalQuote } from "@/lib/global-security";
import type { YahooUsdSearchQuote } from "@/lib/usd-security";
import { stableMarketErrorMessage } from "@/lib/market-api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type YahooSearchPayload = { quotes?: YahooUsdSearchQuote[] };
type SearchResult = NonNullable<ReturnType<typeof normalizeJapaneseQuote>> | NonNullable<ReturnType<typeof normalizeYahooGlobalQuote>> | YahooJapanFundSearchResult;

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

async function searchYahooGlobal(query: string): Promise<SearchResult[]> {
  const failures: string[] = [];
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      const url = new URL(`https://${host}/v1/finance/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("quotesCount", "15");
      url.searchParams.set("newsCount", "0");
      url.searchParams.set("listsCount", "0");
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", "User-Agent": "Kabutora/1.0 personal-portfolio-tracker" },
        signal: AbortSignal.timeout(6_000),
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

async function searchYahooJapan(query: string): Promise<SearchResult[]> {
  const url = new URL("https://finance.yahoo.co.jp/search/");
  url.searchParams.set("query", query);
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
    signal: AbortSignal.timeout(10_000),
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
  } catch {
    return unauthorizedResponse();
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
    task = (async () => {
      const catalogResults = searchKnownJapanFunds(query);
      const looksAmericanOrTicker = /^[A-Za-z0-9.^ -]{1,31}$/u.test(query);
      const looksJapaneseTicker = /^[0-9]{3,4}[A-Za-z]?$/u.test(query);
      const providers: Array<Promise<SearchResult[]>> = looksJapaneseTicker
        ? [searchYahooJapan(query), searchYahooGlobal(query)]
        : looksAmericanOrTicker
          ? [searchYahooGlobal(query)]
          : [searchYahooJapan(query), searchYahooGlobal(query)];
      const searches = await Promise.allSettled(providers);
      const providerResults = searches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      const results = [...new Map([...catalogResults, ...providerResults].map((item) => [item.id, item])).values()].slice(0, 15);
      const warnings = searches.flatMap((result) =>
        result.status === "rejected" ? [stableMarketErrorMessage(result.reason, "一部の検索先から応答がありませんでした")] : [],
      );
      if (results.length) searchCache.set(key, { expiresAt: Date.now() + SEARCH_TTL_MS, results, warnings });
      return { results, warnings };
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
