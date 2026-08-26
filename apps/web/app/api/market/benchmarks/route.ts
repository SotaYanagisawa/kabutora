import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getYahooQuoteBundle } from "@/lib/yahoo-market";
import { portfolioMarketSessions } from "@/lib/market-session";
import { stableMarketErrorMessage } from "@/lib/market-api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BENCHMARKS = [
  { id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X", venue: "FX" },
  { id: "cny-jpy", label: "CNY/JPY", symbol: "CNYJPY=X", venue: "FX" },
  { id: "sp500", label: "S&P 500", symbol: "^GSPC", venue: "US" },
  { id: "nasdaq", label: "NASDAQ", symbol: "^IXIC", venue: "US" },
  { id: "dow", label: "Dow", symbol: "^DJI", venue: "US" },
  { id: "nikkei225", label: "日経225", symbol: "^N225", venue: "TSE" },
  { id: "topix", label: "TOPIX", symbol: "998405.T", venue: "TSE" },
] as const;

async function fetchTopixFromYahooJapan() {
  const response = await fetch("https://finance.yahoo.co.jp/quote/998405.T", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`TOPIX: Yahoo Japan returned ${response.status}`);
  const html = await response.text();
  const marker = html.indexOf('"mainDomesticIndexPriceBoard"');
  if (marker < 0) throw new Error("TOPIX: price board unavailable");
  const board = html.slice(marker, marker + 2600);
  const field = (name: string) => new RegExp(`"${name}":"([^"]*)"`).exec(board)?.[1] ?? "";
  const value = Number(field("price").replaceAll(",", ""));
  const changeRatio = Number(field("changePriceRate")) / 100;
  if (!Number.isFinite(value) || value <= 0) throw new Error("TOPIX: invalid price");
  const updateTime = field("japanUpdateTime");
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((item) => item.type === type)?.value ?? "";
  const marketTimestamp = updateTime ? new Date(`${part("year")}-${part("month")}-${part("day")}T${updateTime}:00+09:00`).toISOString() : new Date().toISOString();
  return { value, changeRatio: Number.isFinite(changeRatio) ? changeRatio : null, marketTimestamp, freshness: "delayed" as const };
}

let topixCache: { value: Awaited<ReturnType<typeof fetchTopixFromYahooJapan>>; expiresAt: number; staleUntil: number } | null = null;

async function getTopixFromYahooJapan(force: boolean) {
  if (!force && topixCache && topixCache.expiresAt > Date.now()) return topixCache.value;
  try {
    const value = await fetchTopixFromYahooJapan();
    topixCache = { value, expiresAt: Date.now() + 15 * 60 * 1000, staleUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    return value;
  } catch (error) {
    if (topixCache && topixCache.staleUntil > Date.now()) return { ...topixCache.value, freshness: "cached" as const };
    throw error;
  }
}

export async function GET(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const results = await Promise.all(BENCHMARKS.map(async (benchmark) => {
    try {
      if (benchmark.id === "topix") {
        return { ok: true as const, benchmark: { ...benchmark, ...(await getTopixFromYahooJapan(force)) } };
      }
      const { quote } = await getYahooQuoteBundle(benchmark.symbol, `benchmark-${benchmark.id}`, benchmark.venue, force);
      const previous = quote.previousRegularClose == null ? null : Number(quote.previousRegularClose);
      const value = Number(quote.price);
      return {
        ok: true as const,
        benchmark: {
          ...benchmark,
          value,
          changeRatio: previous && previous > 0 ? value / previous - 1 : null,
          marketTimestamp: quote.marketTimestamp,
          freshness: quote.freshness,
        },
      };
    } catch (error) {
      return { ok: false as const, failure: { id: benchmark.id, message: stableMarketErrorMessage(error, "市場指標を取得できませんでした") } };
    }
  }));

  const generatedAt = new Date().toISOString();
  const benchmarks = results.flatMap((result) => result.ok ? [{ ...result.benchmark, fetchedAt: generatedAt }] : []);
  const failures = results.flatMap((result) => result.ok ? [] : [result.failure]);
  return Response.json(
    { generatedAt, marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)), benchmarks, failures },
    { status: benchmarks.length ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
