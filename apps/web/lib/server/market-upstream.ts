import { dateInZone } from "@kabutora/domain/dates";
import { normalizeSplits, type Benchmark, type DailyHistory, type Dividend, type Quote, type Session, type Split, type Venue } from "@kabutora/domain/market";
import type { RequestedSecurity } from "../market/market-security";

/** Upstream adapters: network + parsing only. No storage, no portfolio data. */

export const USER_AGENT = "Mozilla/5.0 (compatible; Kabutora/4.0)";
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] as const;
const SPARK_BATCH = 20;
export const MONEX_FUND_ID = "sec-foreign-fund-21070062";

/** Workers Free allows 50 subrequests per invocation; every upstream fetch takes one from the budget. */
export class Budget {
  constructor(public remaining: number) {}
  take(count = 1) {
    if (this.remaining < count) return false;
    this.remaining -= count;
    return true;
  }
}

export class UpstreamError extends Error {}

async function upstream(url: string, budget: Budget, init: RequestInit & { timeoutMs?: number } = {}) {
  if (!budget.take()) throw new UpstreamError("subrequest_budget_exhausted");
  const { timeoutMs = 8_000, headers, ...rest } = init;
  const response = await fetch(url, { ...rest, headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok && response.status !== 304) throw new UpstreamError(`http_${response.status}`);
  return response;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown) => (finite(value) && value > 0 ? value : undefined);

export const venueOf = (security: RequestedSecurity): Venue =>
  security.venueCode === "TSE" ? "TSE"
    : security.venueCode === "US" || security.venueCode === "USD_FUND" ? "US"
    : security.venueCode === "INDEX" ? "INDEX"
    : security.venueCode === "FX" ? "FX"
    : security.venueCode === "FUND" ? "FUND"
    : "GLOBAL";

// ---- Yahoo spark: quotes and intraday ------------------------------------------------------------

type TradingPeriod = { start?: number; end?: number };
export type SparkMeta = {
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
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
export type SparkRow = { symbol: string; meta: SparkMeta; times: number[]; prices: number[] };

export function parseSpark(payload: unknown, into = new Map<string, SparkRow>()) {
  const results = (payload as { spark?: { result?: unknown } } | null)?.spark?.result;
  if (!Array.isArray(results)) return into;
  for (const item of results as Array<{ symbol?: unknown; response?: unknown }>) {
    const response = Array.isArray(item?.response) ? item.response[0] as { meta?: SparkMeta; timestamp?: unknown; indicators?: { quote?: Array<{ close?: unknown }> } } : undefined;
    if (typeof item?.symbol !== "string" || !response?.meta) continue;
    const timestamps = Array.isArray(response.timestamp) ? response.timestamp : [];
    const closes = Array.isArray(response.indicators?.quote?.[0]?.close) ? response.indicators.quote[0].close as unknown[] : [];
    const times: number[] = [];
    const prices: number[] = [];
    for (let index = 0; index < Math.min(timestamps.length, closes.length); index += 1) {
      const time = timestamps[index];
      const price = closes[index];
      if (!finite(time) || !finite(price) || price <= 0) continue;
      times.push(time);
      prices.push(price);
    }
    into.set(item.symbol.toUpperCase(), { symbol: item.symbol, meta: response.meta, times, prices });
  }
  return into;
}

/** Yahoo's spark endpoint: 20 symbols per call, batches in parallel, both hosts as fallback. */
export async function fetchSpark(symbols: readonly string[], range: "1d" | "5d", interval: "5m" | "15m", budget: Budget) {
  const unique = [...new Set(symbols.filter((symbol) => /^[A-Za-z0-9.^=_-]{1,32}$/u.test(symbol)))];
  const results = new Map<string, SparkRow>();
  const batches = Array.from({ length: Math.ceil(unique.length / SPARK_BATCH) }, (_, index) => unique.slice(index * SPARK_BATCH, (index + 1) * SPARK_BATCH));
  await Promise.all(batches.map(async (batch) => {
    for (const host of YAHOO_HOSTS) {
      try {
        const response = await upstream(`https://${host}/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(",")}&range=${range}&interval=${interval}&includePrePost=true`, budget, {
          headers: { Accept: "application/json" }, timeoutMs: 5_000,
        });
        parseSpark(await response.json(), results);
        return;
      } catch (error) {
        if (error instanceof UpstreamError && error.message === "subrequest_budget_exhausted") return;
      }
    }
  }));
  return results;
}

function sessionAt(nowSeconds: number, periods: SparkMeta["currentTradingPeriod"]): Session {
  const within = (period?: TradingPeriod) => Boolean(period?.start && period.end && nowSeconds >= period.start && nowSeconds <= period.end);
  if (within(periods?.pre)) return "pre_market";
  if (within(periods?.regular)) return "regular";
  if (within(periods?.post)) return "after_hours";
  return "closed";
}

const deviation = (price: number, reference: number) => Math.abs(price / reference - 1);

/** Latest trade (extended hours included) unless it is an isolated bad tick; previous regular close. */
export function quoteFromSpark(key: string, security: RequestedSecurity, row: SparkRow, nowSeconds: number): Quote | null {
  const { meta } = row;
  const last = row.times.length ? { time: row.times.at(-1)!, price: row.prices.at(-1)! } : undefined;
  const metaPrice = positive(meta.regularMarketPrice);
  const metaTime = finite(meta.regularMarketTime) ? meta.regularMarketTime : undefined;
  let session = sessionAt(nowSeconds, meta.currentTradingPeriod);
  const useLast = Boolean(last && (metaTime === undefined || last.time > metaTime || session !== "closed"));
  let price = useLast ? last?.price ?? metaPrice : metaPrice ?? last?.price;
  let time = useLast ? last?.time ?? metaTime : metaTime ?? last?.time;
  const previousClose = positive(meta.previousClose) ?? positive(meta.chartPreviousClose) ?? null;
  if (price !== undefined && metaPrice !== undefined && price !== metaPrice && previousClose
    && deviation(price, previousClose) > 0.35 && deviation(metaPrice, previousClose) <= 0.35) {
    price = metaPrice;
    time = metaTime ?? time;
  }
  if (price === undefined || time === undefined) return null;
  if (session === "closed" && metaTime !== undefined && time > metaTime && security.venueCode === "US") session = "after_hours";
  return {
    key,
    price,
    previousClose,
    time,
    session,
    venue: venueOf(security),
    currency: meta.currency?.toUpperCase() || security.currency,
    ...(meta.shortName ? { name: meta.shortName } : {}),
    ...(meta.longName ? { longName: meta.longName } : {}),
    ...(meta.fullExchangeName || meta.exchangeName ? { exchange: meta.fullExchangeName ?? meta.exchangeName } : {}),
    ...(positive(meta.regularMarketDayHigh) ? { dayHigh: meta.regularMarketDayHigh } : {}),
    ...(positive(meta.regularMarketDayLow) ? { dayLow: meta.regularMarketDayLow } : {}),
    ...(finite(meta.regularMarketVolume) ? { volume: meta.regularMarketVolume } : {}),
    fetchedAt: nowSeconds,
  };
}

export const BENCHMARKS = [
  { id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X" },
  { id: "cny-jpy", label: "CNY/JPY", symbol: "CNYJPY=X" },
  { id: "sp500", label: "S&P 500", symbol: "^GSPC" },
  { id: "nasdaq", label: "NASDAQ", symbol: "^IXIC" },
  { id: "dow", label: "Dow", symbol: "^DJI" },
  { id: "nikkei225", label: "日経225", symbol: "^N225" },
] as const;

export function benchmarkFromSpark(benchmark: (typeof BENCHMARKS)[number], row: SparkRow, nowSeconds: number): Benchmark | null {
  const security: RequestedSecurity = { id: benchmark.id, displaySymbol: benchmark.symbol, exchangeMic: "", currency: "", providerSymbol: benchmark.symbol, venueCode: "INDEX" };
  const quote = quoteFromSpark(benchmark.id, security, row, nowSeconds);
  if (!quote) return null;
  return { id: benchmark.id, label: benchmark.label, symbol: benchmark.symbol, value: quote.price, changeRatio: quote.previousClose ? quote.price / quote.previousClose - 1 : null, time: quote.time };
}

// ---- Yahoo chart: daily closes, splits and dividends from one response ---------------------------

type ChartResult = {
  meta?: { currency?: string; exchangeTimezoneName?: string };
  timestamp?: unknown[];
  indicators?: { quote?: Array<{ close?: unknown[] }> };
  events?: {
    splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
    dividends?: Record<string, { date?: number; amount?: number }>;
    capitalGains?: Record<string, { date?: number; amount?: number }>;
  };
};

/**
 * Yahoo divides dividend amounts by later splits, but a dividend sharing its ex-date with a split is
 * sometimes still per pre-split share. Decide by comparing with the neighbouring dividends.
 */
export function normalizeDividends(dividends: readonly Dividend[], splits: readonly Split[]): Dividend[] {
  const byDate = new Map<string, Dividend>();
  for (const dividend of dividends) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dividend.date) || !finite(dividend.amount) || dividend.amount <= 0) continue;
    const current = byDate.get(dividend.date);
    byDate.set(dividend.date, current ? { ...current, amount: current.amount + dividend.amount } : dividend);
  }
  const sorted = [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1));
  const splitOn = new Map(splits.map((split) => [split.date, split.ratio]));
  return sorted.map((dividend, index) => {
    const ratio = splitOn.get(dividend.date);
    if (!ratio) return dividend;
    const neighbours = [sorted[index - 1], sorted[index + 1]].filter((item): item is Dividend => Boolean(item) && !splitOn.has(item!.date));
    if (!neighbours.length) return { ...dividend, amount: dividend.amount / ratio };
    const reference = Math.exp(neighbours.reduce((sum, item) => sum + Math.log(item.amount), 0) / neighbours.length);
    const distance = Math.log(dividend.amount / reference);
    return Math.abs(distance - Math.log(ratio)) < Math.abs(distance) ? { ...dividend, amount: dividend.amount / ratio } : dividend;
  });
}

export function parseChartHistory(payload: unknown, key: string, fallbackCurrency: string, fetchedAt: number): DailyHistory {
  const result = (payload as { chart?: { result?: ChartResult[] | null } } | null)?.chart?.result?.[0];
  if (!result) throw new UpstreamError("empty_chart");
  const zone = result.meta?.exchangeTimezoneName || (fallbackCurrency === "JPY" ? "Asia/Tokyo" : "America/New_York");
  const byDate = new Map<string, number>();
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let index = 0; index < Math.min(timestamps.length, closes.length); index += 1) {
    const time = timestamps[index];
    const close = closes[index];
    if (finite(time) && finite(close) && close > 0) byDate.set(dateInZone(time * 1000, zone), close);
  }
  const dates = [...byDate.keys()].sort();
  const splits = normalizeSplits(Object.values(result.events?.splits ?? {}).flatMap((event) =>
    finite(event.date) && positive(event.numerator) && positive(event.denominator)
      ? [{ date: dateInZone(event.date * 1000, zone), ratio: event.numerator! / event.denominator! }] : []));
  const dividends = [...Object.values(result.events?.dividends ?? {}), ...Object.values(result.events?.capitalGains ?? {})].flatMap((event) =>
    finite(event.date) && positive(event.amount) ? [{ date: dateInZone(event.date * 1000, zone), amount: event.amount! }] : []);
  return {
    key,
    currency: result.meta?.currency?.toUpperCase() || fallbackCurrency,
    dates,
    closes: dates.map((date) => byDate.get(date)!),
    splits,
    dividends: normalizeDividends(dividends, splits),
    fetchedAt,
  };
}

/** Daily closes since `period1` (unix seconds) with every split and dividend in the same window. */
export async function fetchChartHistory(security: RequestedSecurity, key: string, period1: number, budget: Budget, nowSeconds: number) {
  const symbol = security.providerSymbol;
  if (!/^[A-Za-z0-9.^=_-]{1,32}$/u.test(symbol)) throw new UpstreamError("invalid_symbol");
  const query = new URLSearchParams({ interval: "1d", period1: String(period1), period2: String(nowSeconds + 86_400), events: "div|split|capitalGain", includePrePost: "false" });
  let failure: unknown;
  for (const host of YAHOO_HOSTS) {
    try {
      const response = await upstream(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, budget, { headers: { Accept: "application/json" }, timeoutMs: 10_000 });
      return parseChartHistory(await response.json(), key, security.currency, nowSeconds);
    } catch (error) {
      failure = error;
      if (error instanceof UpstreamError && error.message === "subrequest_budget_exhausted") break;
    }
  }
  throw failure instanceof Error ? failure : new UpstreamError("chart_unavailable");
}

// ---- Japanese mutual funds (Yahoo! ファイナンス) -------------------------------------------------

const FUND_UA = "Kabutora/4.0 personal-portfolio-tracker";

export function parseFundPage(html: string) {
  const token = /jwtToken\\?":\\?"([\w.-]+)/u.exec(html)?.[1];
  const name = /priceBoard\\?":\{\\?"code\\?":\\?"[0-9A-Z]{8}\\?",\\?"name\\?":\\?"([^"\\]+)/u.exec(html)?.[1];
  return token ? { token, ...(name ? { name } : {}) } : null;
}

export function parseFundHistory(payload: unknown) {
  const rows = (payload as { priceHistories?: Array<{ baseDate?: unknown; closePrice?: unknown }> } | null)?.priceHistories;
  const byDate = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.baseDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(row.baseDate) && finite(row.closePrice) && row.closePrice > 0) byDate.set(row.baseDate, row.closePrice);
  }
  return byDate;
}

/** NAV per 10,000 units since `from` (YYYY-MM-DD). One page request for the session token, then one request per 8 years. */
export async function fetchJapanFund(code: string, key: string, from: string, budget: Budget, nowSeconds: number) {
  if (!/^[0-9A-Z]{8}$/u.test(code)) throw new UpstreamError("invalid_fund_code");
  const page = await upstream(`https://finance.yahoo.co.jp/quote/${code}/chart`, budget, { headers: { Accept: "text/html", "User-Agent": FUND_UA }, timeoutMs: 10_000 });
  const parsed = parseFundPage(await page.text());
  if (!parsed) throw new UpstreamError("fund_page_unavailable");
  const cookie = (page.headers.getSetCookie?.() ?? []).flatMap((value) => /^(A|XA|B|XB)=([^;]+)/u.exec(value)?.slice(0, 1) ?? []).join("; ");
  const today = dateInZone(nowSeconds * 1000, "Asia/Tokyo");
  const windows: Array<[string, string]> = [];
  for (let start = from; start <= today;) {
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() + 8);
    const last = end.toISOString().slice(0, 10) < today ? end.toISOString().slice(0, 10) : today;
    windows.push([start, last]);
    const next = new Date(`${last}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    start = next.toISOString().slice(0, 10);
  }
  const closes = new Map<string, number>();
  for (const [start, end] of windows) {
    const response = await upstream(`https://finance.yahoo.co.jp/bff-quote/v1/ajax/chart/ex/v1/main/fund/chart/history/${code}?fromDate=${start.replaceAll("-", "")}&size=3000&timeFrame=daily&toDate=${end.replaceAll("-", "")}`, budget, {
      headers: { Accept: "application/json", Referer: `https://finance.yahoo.co.jp/quote/${code}/chart`, "User-Agent": FUND_UA, "jwt-token": parsed.token, ...(cookie ? { Cookie: cookie } : {}) },
      timeoutMs: 12_000,
    });
    for (const [date, close] of parseFundHistory(await response.json())) closes.set(date, close);
  }
  const dates = [...closes.keys()].sort();
  if (!dates.length) throw new UpstreamError("fund_history_empty");
  const history: DailyHistory = { key, currency: "JPY", dates, closes: dates.map((date) => closes.get(date)!), splits: [], dividends: [], fetchedAt: nowSeconds };
  return { history, ...(parsed.name ? { name: parsed.name } : {}) };
}

export function parseFundDistributions(html: string): Dividend[] {
  const events = new Map<string, number>();
  for (const match of html.matchAll(/\\?"date\\?":\\?"(20\d{2})\/(\d{1,2})\/(\d{1,2})\\?",\\?"price\\?":\\?"([0-9,.]+)/gu)) {
    const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const amount = Number(match[4].replaceAll(",", ""));
    if (Number.isFinite(amount) && amount >= 0) events.set(date, amount);
  }
  return [...events].sort(([left], [right]) => (left < right ? -1 : 1)).map(([date, amount]) => ({ date, amount }));
}

const BLACKROCK_PAGES: Record<string, string> = {
  "48314059": "https://www.blackrock.com/jp/individual/ja/products/261009/blackrock-global-equity-income-open",
};

export function parseBlackRockDistributions(payload: unknown): Dividend[] {
  const rows = (payload as { table?: { aaData?: Array<Array<{ raw?: unknown }>> } } | null)?.table?.aaData;
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const raw = String(row?.[0]?.raw ?? "");
    const amount = Number(row?.[1]?.raw);
    if (!/^20\d{6}$/u.test(raw) || !Number.isFinite(amount) || amount < 0) return [];
    return [{ date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, amount }];
  }).sort((left, right) => (left.date < right.date ? -1 : 1));
}

/** Distributions per 10,000 units: the manager's official table when known, else Yahoo's recent list. */
export async function fetchFundDistributions(code: string, budget: Budget): Promise<Dividend[]> {
  const product = BLACKROCK_PAGES[code];
  if (product) {
    try {
      const page = await (await upstream(product, budget, { headers: { Accept: "text/html" }, timeoutMs: 12_000 })).text();
      const endpoint = /data-ajaxuri="([^"]+\.ajax\?tab=distributions&(?:amp;)?fileType=json&(?:amp;)?subtab=table)"/u.exec(page)?.[1];
      if (endpoint) {
        const response = await upstream(new URL(endpoint.replaceAll("&amp;", "&"), product).toString(), budget, { headers: { Accept: "application/json", Referer: product }, timeoutMs: 12_000 });
        const events = parseBlackRockDistributions(JSON.parse((await response.text()).replace(/^\uFEFF/u, "")));
        if (events.length) return events;
      }
    } catch { /* Fall back to Yahoo below. */ }
  }
  const response = await upstream(`https://finance.yahoo.co.jp/quote/${code}/dividendinfo`, budget, { headers: { Accept: "text/html", "User-Agent": FUND_UA }, timeoutMs: 10_000 });
  return parseFundDistributions(await response.text());
}

export function parseMonexPage(html: string): Map<string, number> {
  const match = /var chartData = (\[[\s\S]*?\]);/u.exec(html);
  const closes = new Map<string, number>();
  if (!match) return closes;
  try {
    for (const point of JSON.parse(match[1]) as Array<{ dt?: unknown; p?: unknown }>) {
      if (finite(point?.dt) && finite(point?.p) && point.p > 0) closes.set(dateInZone(point.dt, "Asia/Tokyo"), point.p);
    }
  } catch { /* Malformed page: no data. */ }
  return closes;
}

/** Monex foreign fund NAV (USD): one page holds the whole history. */
export async function fetchMonexFund(code: string, key: string, budget: Budget, nowSeconds: number): Promise<{ history: DailyHistory; name: string }> {
  if (code !== "0162") throw new UpstreamError("unsupported_foreign_fund");
  const response = await upstream(`https://fund.monex.co.jp/detail/${code}`, budget, { headers: { Accept: "text/html", "User-Agent": FUND_UA }, timeoutMs: 15_000 });
  const closes = parseMonexPage(await response.text());
  const dates = [...closes.keys()].sort();
  if (dates.length < 2) throw new UpstreamError("foreign_fund_history_empty");
  return {
    history: { key, currency: "USD", dates, closes: dates.map((date) => closes.get(date)!), splits: [], dividends: [], fetchedAt: nowSeconds },
    name: "ジャナス・フォーティ・ファンド クラスA（米ドル）",
  };
}

/** NAV quote from a fund's daily history: the latest NAV against the previous one. */
export function fundQuote(key: string, history: DailyHistory, nowSeconds: number, name?: string): Quote | null {
  const last = history.closes.length - 1;
  if (last < 0) return null;
  return {
    key,
    price: history.closes[last],
    previousClose: last > 0 ? history.closes[last - 1] : null,
    time: Date.parse(`${history.dates[last]}T15:00:00+09:00`) / 1000,
    session: "closed",
    venue: "FUND",
    currency: history.currency,
    ...(name ? { name, longName: name } : {}),
    exchange: "投資信託",
    fetchedAt: nowSeconds,
  };
}

// ---- Japannext PTS ---------------------------------------------------------------------------------

export type PtsWindow = { venue: "day" | "night"; session: "pts_day" | "pts_night"; sessionKey: string };

/** Japannext windows (JST): day 08:20–16:30, night 17:00–06:00 (after midnight belongs to the previous date). */
export function ptsWindowAt(unixMs: number): PtsWindow | null {
  const tokyo = new Date(unixMs + 9 * 3_600_000);
  const minute = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
  const date = tokyo.toISOString().slice(0, 10);
  const weekday = tokyo.getUTCDay();
  if (minute >= 8 * 60 + 20 && minute <= 16 * 60 + 30 && weekday >= 1 && weekday <= 5) return { venue: "day", session: "pts_day", sessionKey: date };
  if (minute >= 17 * 60 && weekday >= 1 && weekday <= 5) return { venue: "night", session: "pts_night", sessionKey: date };
  if (minute < 6 * 60 && weekday >= 2 && weekday <= 6) {
    const previous = new Date(tokyo);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return { venue: "night", session: "pts_night", sessionKey: previous.toISOString().slice(0, 10) };
  }
  return null;
}

/** Japannext's assignment-form batch file, parsed as data (never evaluated). Symbols traded this session only. */
export function parsePtsSource(source: string): Map<string, number> {
  const rows = new Map<string, number>();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^mdata\[\s*\d+\s*\]\s*=\s*(\[.*\]);\s*$/u.exec(line.trim());
    if (!match) continue;
    let row: unknown;
    try { row = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(row) || row.length !== 9) continue;
    const [symbol, , , , , , , last, volume] = row as unknown[];
    if (typeof symbol !== "string" || !/^(?:\d{4}|\d{3}[A-Z])$/u.test(symbol)) continue;
    const price = Number(last);
    if (Number.isFinite(price) && price > 0 && Number(volume) > 0) rows.set(symbol, price);
  }
  return rows;
}

const PTS_URLS = {
  day: "https://www.japannext.co.jp/pub_data/pts_info/pts_info_execution_J.js",
  night: "https://www.japannext.co.jp/pub_data/pts_info/pts_info_execution_N.js",
} as const;

export async function fetchPts(window: PtsWindow, budget: Budget, nowMs: number) {
  const response = await upstream(PTS_URLS[window.venue], budget, { headers: { Accept: "text/javascript,text/plain;q=0.9" }, timeoutMs: 6_000 });
  const text = await response.text();
  if (text.length > 600_000) throw new UpstreamError("pts_source_too_large");
  const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
  return { at: Math.floor(Math.min(Number.isFinite(modified) ? modified : nowMs, nowMs) / 1000), last: parsePtsSource(text) };
}

// ---- TOPIX (Yahoo! ファイナンス index board) -------------------------------------------------------

export function parseTopixPage(html: string, nowSeconds: number): Benchmark | null {
  const marker = html.indexOf('"mainDomesticIndexPriceBoard"');
  if (marker < 0) return null;
  const board = html.slice(marker, marker + 2_600);
  const field = (name: string) => new RegExp(`"${name}":"([^"]*)"`, "u").exec(board)?.[1] ?? "";
  const price = Number(field("price").replaceAll(",", ""));
  if (!(price > 0)) return null;
  const change = Number(field("changePriceRate"));
  const time = /^(\d{1,2}):(\d{2})$/u.exec(field("japanUpdateTime"));
  let at = nowSeconds;
  if (time) {
    const today = dateInZone(nowSeconds * 1000, "Asia/Tokyo");
    const candidate = Date.parse(`${today}T${time[1].padStart(2, "0")}:${time[2]}:00+09:00`) / 1000;
    at = candidate <= nowSeconds ? candidate : candidate - 86_400;
  }
  return { id: "topix", label: "TOPIX", symbol: "998405.T", value: price, changeRatio: Number.isFinite(change) ? change / 100 : null, time: at };
}

export async function fetchTopix(budget: Budget, nowSeconds: number) {
  const response = await upstream("https://finance.yahoo.co.jp/quote/998405.T", budget, { timeoutMs: 5_000 });
  const benchmark = parseTopixPage(await response.text(), nowSeconds);
  if (!benchmark) throw new UpstreamError("topix_unavailable");
  return benchmark;
}
