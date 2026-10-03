import { Decimal, type CorporateAction, type DistributionEvent, type MarketBar, type MarketQuote } from "@kabutora/domain";
import { getMonexForeignFundHistory, getMonexForeignFundQuoteBundle } from "./providers/monex-foreign-fund";
import { getYahooJapanFundDistributions, getYahooJapanFundHistory, getYahooJapanFundQuoteBundle } from "./providers/yahoo-japan-fund";
import { getYahooHistory, tokyoMarketTimestamp } from "./providers/yahoo-market";
import { JAPANNEXT_PTS_URLS, parseJapannextPtsSource, type JapannextPtsWindow } from "./providers/japannext-pts";
import { inspectMarketHistory } from "../market/market-history";
import type { RequestedSecurity } from "../market/market-security";
import type { DistributionCoverage, ServerBenchmark, ServerRemoteQuote } from "../market/market-api-types";

/** Upstream adapters. Pure network + parsing; no storage, no portfolio data. */

export const USER_AGENT = "Mozilla/5.0 (compatible; Kabutora/3.0)";
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] as const;
const SPARK_BATCH = 20;
export const MONEX_FUND_ID = "sec-foreign-fund-21070062";

/** Compact chart series; `t` holds unix seconds. */
export type PriceSeries = {
  id: string;
  provider: string;
  t: number[];
  p: number[];
  session?: MarketQuote["session"];
  venueCode?: string;
};

type TradingPeriod = { start?: number; end?: number };
export type SparkMeta = {
  currency?: string;
  exchangeName?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  currentTradingPeriod?: { pre?: TradingPeriod; regular?: TradingPeriod; post?: TradingPeriod };
};
export type SparkResult = { symbol: string; meta: SparkMeta; t: number[]; p: number[] };

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const positive = (value: unknown) => { const number = finite(value); return number !== undefined && number > 0 ? number : undefined; };
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
/** |a/b - 1| with Decimal; prices stay exact strings everywhere else. */
const deviation = (price: number, reference: number) => new Decimal(String(price)).div(String(reference)).sub(1).abs();

export function parseSpark(payload: unknown, into = new Map<string, SparkResult>()) {
  const results = (payload as { spark?: { result?: unknown } } | null)?.spark?.result;
  if (!Array.isArray(results)) return into;
  for (const item of results as Array<{ symbol?: unknown; response?: unknown }>) {
    const response = Array.isArray(item?.response) ? item.response[0] as { meta?: SparkMeta; timestamp?: unknown; indicators?: { quote?: Array<{ close?: unknown }> } } : undefined;
    if (typeof item?.symbol !== "string" || !response?.meta) continue;
    const timestamps = Array.isArray(response.timestamp) ? response.timestamp : [];
    const closes = Array.isArray(response.indicators?.quote?.[0]?.close) ? response.indicators.quote[0].close as unknown[] : [];
    const t: number[] = [];
    const p: number[] = [];
    for (let index = 0; index < Math.min(timestamps.length, closes.length); index += 1) {
      const time = finite(timestamps[index]);
      const close = positive(closes[index]);
      if (time === undefined || close === undefined) continue;
      t.push(time);
      p.push(close);
    }
    into.set(item.symbol.toUpperCase(), { symbol: item.symbol, meta: response.meta, t, p });
  }
  return into;
}

/** Yahoo's spark endpoint returns 20 symbols per call without a crumb; batches run in parallel. */
export async function fetchSpark(symbols: readonly string[], range: "1d" | "5d", interval: "5m" | "15m") {
  const unique = [...new Set(symbols.filter((symbol) => /^[A-Za-z0-9.^=_-]{1,32}$/u.test(symbol)))];
  const results = new Map<string, SparkResult>();
  const batches = Array.from({ length: Math.ceil(unique.length / SPARK_BATCH) }, (_, index) => unique.slice(index * SPARK_BATCH, (index + 1) * SPARK_BATCH));
  await Promise.all(batches.map(async (batch) => {
    for (const host of YAHOO_HOSTS) {
      try {
        const response = await fetch(`https://${host}/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(",")}&range=${range}&interval=${interval}&includePrePost=true`, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) continue;
        parseSpark(await response.json(), results);
        return;
      } catch { /* Try the other Yahoo host. */ }
    }
  }));
  return results;
}

function sessionAt(nowSeconds: number, periods: SparkMeta["currentTradingPeriod"]): MarketQuote["session"] {
  const within = (period?: TradingPeriod) => Boolean(period?.start && period.end && nowSeconds >= period.start && nowSeconds <= period.end);
  if (within(periods?.pre)) return "pre_market";
  if (within(periods?.regular)) return "regular";
  if (within(periods?.post)) return "after_hours";
  return "closed";
}

function freshnessFor(session: MarketQuote["session"], ageSeconds: number): MarketQuote["freshness"] {
  if (session !== "closed") return ageSeconds <= 120 ? "live" : ageSeconds <= 15 * 60 ? "near_live" : "delayed";
  return ageSeconds <= 3 * 86_400 ? "near_live" : ageSeconds <= 7 * 86_400 ? "cached" : "stale";
}

/** Same price-selection and bad-tick rules as the former per-symbol chart adapter. */
export function quoteFromSpark(security: RequestedSecurity, spark: SparkResult, nowMs = Date.now()): ServerRemoteQuote | null {
  const { meta } = spark;
  const nowSeconds = nowMs / 1000;
  const lastIndex = spark.t.length - 1;
  const last = lastIndex >= 0 ? { time: spark.t[lastIndex], price: spark.p[lastIndex] } : undefined;
  const metaPrice = positive(meta.regularMarketPrice);
  const metaTime = finite(meta.regularMarketTime);
  const session = sessionAt(nowSeconds, meta.currentTradingPeriod);
  const useLast = Boolean(last && (metaTime === undefined || last.time > metaTime)) || session !== "closed";
  let price = useLast ? last?.price ?? metaPrice : metaPrice ?? last?.price;
  let time = useLast ? last?.time ?? metaTime : metaTime ?? last?.time;
  const previousClose = positive(meta.previousClose) ?? positive(meta.chartPreviousClose);
  if (price !== undefined && metaPrice !== undefined && price !== metaPrice && previousClose
    && deviation(price, previousClose).gt("0.35") && deviation(metaPrice, previousClose).lte("0.35")) {
    price = metaPrice;
    time = metaTime ?? time;
  }
  if (price === undefined || time === undefined) return null;
  const ageSeconds = Math.max(0, nowSeconds - time);
  return {
    securityId: security.id,
    symbol: security.displaySymbol,
    exchangeMic: security.exchangeMic,
    currency: security.currency,
    ...(meta.exchangeName ? { exchangeLabel: meta.exchangeName } : {}),
    ...(meta.shortName ? { shortName: meta.shortName } : {}),
    ...(meta.longName ? { longName: meta.longName } : {}),
    price: String(price),
    ...(previousClose ? { previousRegularClose: String(previousClose) } : {}),
    ...(positive(meta.regularMarketDayHigh) ? { dayHigh: String(meta.regularMarketDayHigh) } : {}),
    ...(positive(meta.regularMarketDayLow) ? { dayLow: String(meta.regularMarketDayLow) } : {}),
    ...(finite(meta.regularMarketVolume) !== undefined ? { dayVolume: String(meta.regularMarketVolume) } : {}),
    marketTimestamp: iso(time),
    fetchedAt: new Date(nowMs).toISOString(),
    freshness: freshnessFor(session, ageSeconds),
    provider: "yahoo_spark",
    session,
    priceType: session === "closed" ? "official_close" : ageSeconds <= 15 * 60 ? "last_trade" : "delayed_last",
    venueCode: security.venueCode,
    validationStatus: previousClose && deviation(price, previousClose).gt("0.35") ? "suspect" : "valid",
  };
}

export const BENCHMARKS = [
  { id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X" },
  { id: "cny-jpy", label: "CNY/JPY", symbol: "CNYJPY=X" },
  { id: "sp500", label: "S&P 500", symbol: "^GSPC" },
  { id: "nasdaq", label: "NASDAQ", symbol: "^IXIC" },
  { id: "dow", label: "Dow", symbol: "^DJI" },
  { id: "nikkei225", label: "日経225", symbol: "^N225" },
  { id: "topix", label: "TOPIX", symbol: "998405.T" },
] as const;
export const SPARK_BENCHMARK_SYMBOLS = BENCHMARKS.filter((benchmark) => benchmark.id !== "topix").map((benchmark) => benchmark.symbol);

export function benchmarkFromSpark(benchmark: typeof BENCHMARKS[number], spark: SparkResult, nowMs = Date.now()): ServerBenchmark | null {
  const quote = quoteFromSpark({ id: benchmark.id, displaySymbol: benchmark.symbol, exchangeMic: "", currency: "", providerSymbol: benchmark.symbol, venueCode: "INDEX" }, spark, nowMs);
  if (!quote) return null;
  return {
    id: benchmark.id,
    label: benchmark.label,
    symbol: benchmark.symbol,
    value: Number(quote.price),
    changeRatio: quote.previousRegularClose ? new Decimal(quote.price).div(quote.previousRegularClose).sub(1).toNumber() : null,
    marketTimestamp: quote.marketTimestamp,
    freshness: quote.freshness,
    fetchedAt: quote.fetchedAt,
  };
}

/** TOPIX is not on Yahoo's US endpoints; read Yahoo Japan's index board. */
export async function fetchTopix(nowMs = Date.now()): Promise<ServerBenchmark> {
  const response = await fetch("https://finance.yahoo.co.jp/quote/998405.T", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`topix_http_${response.status}`);
  const html = await response.text();
  const marker = html.indexOf('"mainDomesticIndexPriceBoard"');
  if (marker < 0) throw new Error("topix_board_missing");
  const board = html.slice(marker, marker + 2_600);
  const field = (name: string) => new RegExp(`"${name}":"([^"]*)"`, "u").exec(board)?.[1] ?? "";
  const price = field("price").replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/u.test(price) || Number(price) <= 0) throw new Error("topix_price_invalid");
  const change = field("changePriceRate");
  return {
    id: "topix",
    label: "TOPIX",
    symbol: "998405.T",
    value: Number(price),
    changeRatio: /^[+-]?\d+(?:\.\d+)?$/u.test(change) ? new Decimal(change).div(100).toNumber() : null,
    marketTimestamp: tokyoMarketTimestamp(field("japanUpdateTime")),
    freshness: "delayed",
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

const fundTime = (timestamp: string) => Math.floor(Date.parse(timestamp) / 1000);

/** Japanese mutual-fund NAVs (one page + one history call each); the adapters cache for hours. */
export async function fetchFundQuote(security: RequestedSecurity): Promise<{ quote: ServerRemoteQuote; series: PriceSeries | null }> {
  const bundle = security.id === MONEX_FUND_ID
    ? await getMonexForeignFundQuoteBundle(security.providerSymbol, security.id)
    : await getYahooJapanFundQuoteBundle(security.providerSymbol, security.id);
  const points = bundle.intraday.filter((bar) => Number.isFinite(Date.parse(bar.timestamp)) && Number(bar.price) > 0);
  return {
    quote: {
      securityId: security.id,
      symbol: security.displaySymbol,
      exchangeMic: security.exchangeMic,
      currency: security.currency,
      exchangeLabel: bundle.exchangeLabel,
      shortName: bundle.shortName,
      longName: bundle.longName,
      ...bundle.quote,
    },
    series: points.length ? { id: security.id, provider: bundle.quote.provider, t: points.map((bar) => fundTime(bar.timestamp)), p: points.map((bar) => Number(bar.price)) } : null,
  };
}

export type PtsFrame = {
  minute: number;
  sessionKey: string;
  venueCode: JapannextPtsWindow["venueCode"];
  session: JapannextPtsWindow["session"];
  sourceAt: number;
  rows: Record<string, [last: string, volume: string]>;
};

/** One request covers every Japannext symbol; conditional headers make unchanged minutes cheap. */
export async function fetchJapannextFrame(window: JapannextPtsWindow, symbols: ReadonlySet<string>, nowMs: number, validator?: { etag?: string | null; lastModified?: string | null }) {
  const headers = new Headers({ Accept: "text/javascript,text/plain;q=0.9", "User-Agent": USER_AGENT });
  if (validator?.etag) headers.set("If-None-Match", validator.etag);
  if (validator?.lastModified) headers.set("If-Modified-Since", validator.lastModified);
  const response = await fetch(JAPANNEXT_PTS_URLS[window.venue], { headers, signal: AbortSignal.timeout(6_000) });
  if (response.status === 304) return { status: "unchanged" as const };
  if (!response.ok) throw new Error(`pts_http_${response.status}`);
  const rows = parseJapannextPtsSource(await response.text(), symbols);
  const lastModified = response.headers.get("Last-Modified");
  const sourceAt = lastModified && Number.isFinite(Date.parse(lastModified)) ? Math.min(Date.parse(lastModified), nowMs) : nowMs;
  const frame: PtsFrame = {
    minute: Math.floor(nowMs / 60_000),
    sessionKey: window.sessionKey,
    venueCode: window.venueCode,
    session: window.session,
    sourceAt,
    rows: Object.fromEntries(rows.map((row) => [row.symbol, [row.last, row.volume]])),
  };
  return { status: "stored" as const, frame, etag: response.headers.get("ETag"), lastModified };
}

export type HistoryFetch = {
  generatedAt: string;
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  distributions: DistributionEvent[];
  inceptionDates: Record<string, string>;
  coverage: DistributionCoverage[];
  failures: Array<{ securityId: string; message: string }>;
  succeeded: string[];
};

const HISTORY_FROM = "2000-01-01";
const failureMessage = (error: unknown) => error instanceof Error ? error.message.slice(0, 160) : "market_history_unavailable";

async function pooled<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

/** Daily closes (or distributions only) since 2000 for public securities. */
export async function fetchHistory(securities: RequestedSecurity[], options: { distributionsOnly?: boolean } = {}): Promise<HistoryFetch> {
  const start = new Date(`${HISTORY_FROM}T00:00:00+09:00`);
  start.setUTCDate(start.getUTCDate() - 7);
  const period1 = Math.floor(start.getTime() / 1000);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 2);
  const period2 = Math.floor(end.getTime() / 1000);
  const results = await pooled(securities, 6, async (security) => {
    try {
      const fund = security.venueCode === "FUND";
      const monex = security.id === MONEX_FUND_ID;
      const history = options.distributionsOnly
        ? fund
          ? { bars: [], corporateActions: [], distributions: monex ? [] : await getYahooJapanFundDistributions(security.providerSymbol, security.id) }
          : await getYahooHistory(security.providerSymbol, security.id, period1, period2, false, true)
        : fund
          ? monex
            ? await getMonexForeignFundHistory(security.providerSymbol, security.id, period1, period2)
            : await getYahooJapanFundHistory(security.providerSymbol, security.id, period1, period2)
          : await getYahooHistory(security.providerSymbol, security.id, period1, period2);
      return { ok: true as const, security, ...history };
    } catch (error) {
      return { ok: false as const, security, message: failureMessage(error) };
    }
  });
  const successes = results.filter((result) => result.ok);
  const inspected = inspectMarketHistory([], successes.flatMap((result) => result.bars), successes.flatMap((result) => result.corporateActions));
  const generatedAt = new Date().toISOString();
  const distributions = successes.flatMap((result) => "distributions" in result && Array.isArray(result.distributions) ? result.distributions : []);
  return {
    generatedAt,
    bars: inspected.bars,
    corporateActions: inspected.actions,
    distributions,
    inceptionDates: Object.fromEntries(successes.flatMap((result) => "inceptionDate" in result && result.inceptionDate ? [[result.security.id, result.inceptionDate]] : [])),
    coverage: successes.map((result) => {
      const events = distributions.filter((event) => event.securityId === result.security.id && new Decimal(event.amountPerUnit).gt(0));
      const sourceProvider = events[0]?.sourceProvider ?? result.corporateActions[0]?.sourceProvider;
      return {
        securityId: result.security.id,
        coveredFrom: HISTORY_FROM,
        checkedThrough: generatedAt.slice(0, 10),
        checkedAt: generatedAt,
        eventCount: events.length,
        status: events.length ? "ready" as const : "no_events" as const,
        ...(sourceProvider ? { sourceProvider } : {}),
      };
    }),
    failures: results.flatMap((result) => result.ok ? [] : [{ securityId: result.security.id, message: result.message }]),
    succeeded: successes.map((result) => result.security.id),
  };
}
