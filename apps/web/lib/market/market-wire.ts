import type { Benchmark, DailyHistory, Dividend, IntradaySeries, Quote, Session, Split, Venue } from "@kabutora/domain/market";

/**
 * Market API wire format, shared by the market backend (edge) and the browser.
 *
 * GET  /api/market/snapshot?intraday=<rev>  quotes + benchmarks for the whole catalog; intraday series when <rev> is stale
 * GET  /api/market/history?from=YYYY-01-01  one record per catalog security: closes, splits, dividends (same upstream response)
 * POST /api/market/registry                 { securityIds: [id] } adds one explicitly selected security to the catalog
 * POST /api/market/search                   { q }
 * GET  /api/market/health
 *
 * Requests never carry a portfolio's symbol list: every member reads the whole catalog and filters locally.
 */

export const MARKET_WIRE_VERSION = 4;

export type PackedSeries = {
  /** Unix seconds; first value absolute, then deltas. */
  t: number[];
  p: number[];
};

export type SnapshotPayload = {
  version: typeof MARKET_WIRE_VERSION;
  /** Unix seconds. */
  generatedAt: number;
  revision: string;
  catalog: string[];
  quotes: Quote[];
  benchmarks: Benchmark[];
  historyRevision: string;
  intradayRevision: string;
  intraday?: Record<string, PackedSeries>;
};

export type PackedHistory = {
  /** Currency. */
  c: string;
  /** First date (YYYY-MM-DD). */
  d: string;
  /** Day gaps between consecutive dates; first is 0. */
  g: number[];
  /** Closes in today's share units. */
  p: number[];
  s: Array<[date: string, ratio: number]>;
  v: Array<[date: string, amount: number] | [date: string, amount: number, payDate: string]>;
  /** Unix seconds. */
  f: number;
};

export type HistoryPayload = {
  version: typeof MARKET_WIRE_VERSION;
  revision: string;
  generatedAt: number;
  from: string;
  records: Record<string, PackedHistory>;
  /** Catalog keys whose first history fetch has not completed yet. */
  pending: string[];
};

export type SearchResultSecurity = {
  id: string;
  displaySymbol: string;
  name: string;
  assetType: "stock" | "etf" | "fund" | "index";
  country: string;
  exchangeMic: string;
  exchangeLabel?: string;
  currency: string;
  timezone?: string;
  priceUnit?: string;
  providerSymbols: { yahoo?: string; monex?: string };
};

/** 10 significant digits removes float32 noise without changing real prices. */
export const roundPrice = (value: number) => Number(value.toPrecision(10));

export function packSeries(series: IntradaySeries): PackedSeries {
  return {
    t: series.times.map((time, index) => (index ? time - series.times[index - 1] : time)),
    p: series.prices.map(roundPrice),
  };
}

export function unpackSeries(packed: PackedSeries): IntradaySeries {
  const times: number[] = [];
  let time = 0;
  for (const [index, delta] of packed.t.entries()) times.push(time = index ? time + delta : delta);
  return { times, prices: [...packed.p] };
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function packHistory(history: DailyHistory, from = ""): PackedHistory {
  const start = history.dates.findIndex((date) => date >= from);
  const dates = start < 0 ? [] : history.dates.slice(start);
  const closes = start < 0 ? [] : history.closes.slice(start);
  return {
    c: history.currency,
    d: dates[0] ?? "",
    g: dates.map((date, index) => (index ? dayNumber(date) - dayNumber(dates[index - 1]) : 0)),
    p: closes.map(roundPrice),
    s: history.splits.filter((split) => split.date >= from).map((split) => [split.date, split.ratio]),
    v: history.dividends.filter((dividend) => dividend.date >= from)
      .map((dividend) => dividend.payDate ? [dividend.date, roundPrice(dividend.amount), dividend.payDate] : [dividend.date, roundPrice(dividend.amount)]),
    f: history.fetchedAt,
  };
}

export function unpackHistory(key: string, packed: PackedHistory): DailyHistory {
  const dates: string[] = [];
  let day = packed.d ? dayNumber(packed.d) : 0;
  for (const [index, gap] of packed.g.entries()) {
    if (index) day += gap;
    dates.push(fromDayNumber(day));
  }
  return {
    key,
    currency: packed.c,
    dates,
    closes: [...packed.p],
    splits: packed.s.map(([date, ratio]): Split => ({ date, ratio })),
    dividends: packed.v.map(([date, amount, payDate]): Dividend => (payDate ? { date, amount, payDate } : { date, amount })),
    fetchedAt: packed.f,
  };
}

// ---- Validation (browser side) -------------------------------------------------------------------

const SESSIONS = new Set<Session>(["pre_market", "regular", "after_hours", "pts_day", "pts_night", "closed"]);
const VENUES = new Set<Venue>(["TSE", "JNX", "US", "FUND", "INDEX", "FX", "GLOBAL"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(finite);

function validQuote(value: unknown): value is Quote {
  if (!isObject(value)) return false;
  return typeof value.key === "string" && positive(value.price) && (value.previousClose === null || positive(value.previousClose))
    && finite(value.time) && SESSIONS.has(value.session as Session) && VENUES.has(value.venue as Venue)
    && typeof value.currency === "string" && finite(value.fetchedAt)
    && (value.regularPrice === undefined || (positive(value.regularPrice) && finite(value.regularTime)));
}

function validBenchmark(value: unknown): value is Benchmark {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string" && positive(value.value)
    && (value.changeRatio === null || finite(value.changeRatio)) && finite(value.time);
}

function validSeries(value: unknown): value is PackedSeries {
  return isObject(value) && numbers(value.t) && numbers(value.p) && value.t.length === value.p.length && value.p.every(positive);
}

function validHistory(value: unknown): value is PackedHistory {
  if (!isObject(value) || typeof value.c !== "string" || typeof value.d !== "string" || !numbers(value.g) || !numbers(value.p) || !finite(value.f)) return false;
  if (value.g.length !== value.p.length || !value.p.every(positive) || (value.g.length > 0 && !isDate(value.d))) return false;
  return Array.isArray(value.s) && value.s.every((item) => Array.isArray(item) && isDate(item[0]) && positive(item[1]))
    && Array.isArray(value.v) && value.v.every((item) => Array.isArray(item) && isDate(item[0]) && finite(item[1]) && (item[2] === undefined || isDate(item[2])));
}

/** Validates a snapshot; invalid quotes and series are dropped, a malformed envelope returns null. */
export function parseSnapshotPayload(value: unknown): SnapshotPayload | null {
  if (!isObject(value) || value.version !== MARKET_WIRE_VERSION || !finite(value.generatedAt) || typeof value.revision !== "string") return null;
  if (!Array.isArray(value.quotes) || !Array.isArray(value.benchmarks) || !Array.isArray(value.catalog)) return null;
  const intraday = isObject(value.intraday)
    ? Object.fromEntries(Object.entries(value.intraday).filter(([, series]) => validSeries(series))) as Record<string, PackedSeries>
    : undefined;
  return {
    version: MARKET_WIRE_VERSION,
    generatedAt: value.generatedAt,
    revision: value.revision,
    catalog: value.catalog.filter((item): item is string => typeof item === "string"),
    quotes: value.quotes.filter(validQuote),
    benchmarks: value.benchmarks.filter(validBenchmark),
    historyRevision: typeof value.historyRevision === "string" ? value.historyRevision : "",
    intradayRevision: typeof value.intradayRevision === "string" ? value.intradayRevision : "",
    ...(intraday ? { intraday } : {}),
  };
}

export function parseHistoryPayload(value: unknown): HistoryPayload | null {
  if (!isObject(value) || value.version !== MARKET_WIRE_VERSION || typeof value.revision !== "string" || !isObject(value.records)) return null;
  return {
    version: MARKET_WIRE_VERSION,
    revision: value.revision,
    generatedAt: finite(value.generatedAt) ? value.generatedAt : 0,
    from: typeof value.from === "string" ? value.from : "",
    records: Object.fromEntries(Object.entries(value.records).filter(([, record]) => validHistory(record))) as Record<string, PackedHistory>,
    pending: Array.isArray(value.pending) ? value.pending.filter((item): item is string => typeof item === "string") : [],
  };
}
