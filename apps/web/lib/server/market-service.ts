import { addDays, dateInZone } from "@kabutora/domain/dates";
import { FX_KEY, marketKey, type Benchmark, type DailyHistory, type IntradaySeries, type Quote } from "@kabutora/domain/market";
import { normalizeRequestedSecurity, type RequestedSecurity } from "../market/market-security";
import { MARKET_WIRE_VERSION, packHistory, packSeries, type HistoryPayload, type SnapshotPayload } from "../market/market-wire";
import {
  BENCHMARKS,
  Budget,
  MONEX_FUND_ID,
  benchmarkFromSpark,
  fetchChartHistory,
  fetchFundDistributions,
  fetchJapanFund,
  fetchMonexFund,
  fetchPts,
  fetchSpark,
  fetchTopix,
  fundQuote,
  ptsWindowAt,
  quoteFromSpark,
} from "./market-upstream";

/**
 * The market backend: one shared catalog of at most 200 public securities.
 *
 * - Quotes and benchmarks are served from memory at once. A read older than 8 s starts one shared
 *   background refresh; a read waits for upstream only when forced or when quotes are over a minute
 *   old (cold object, long idle). The cron keeps quotes warm while anyone has read in the last 15 min.
 * - Intraday 15-minute series (5 days), fund NAVs, TOPIX and Japannext PTS refresh in the background.
 * - Pre-market, after-hours and PTS quotes carry the regular-session price they moved away from.
 * - Daily history is one record per security built from ONE upstream response: split-adjusted closes,
 *   splits and dividends together. A refresh either appends to a record whose overlapping closes still
 *   match, or replaces the whole record. Records from different sources are never merged.
 */

export const MAX_CATALOG = 200;
const QUOTE_TTL_MS = 8_000;
const FORCED_TTL_MS = 3_000;
/** Older quotes are not served without first waiting for a refresh. */
const QUOTE_SERVE_STALE_MS = 60_000;
const QUOTE_WAIT_MS = 6_000;
/** The cron refreshes quotes while a snapshot was read this recently. */
const READER_ACTIVE_MS = 15 * 60_000;
const COLD_WAIT_MS = 3_000;
const WEEK_TTL_MS = 5 * 60_000;
const FUND_TTL_MS = 30 * 60_000;
const TOPIX_TTL_MS = 5 * 60_000;
// Japannext rewrites its files once a minute; slightly less keeps a once-a-minute cron from skipping one.
const PTS_TTL_MS = 50_000;
const PTS_OVERLAY_MS = 12 * 3_600_000;
const PTS_KEEP_SECONDS = 3 * 86_400;
const RETRY_MS = 30 * 60_000;
const DISTRIBUTION_TTL_MS = 24 * 3_600_000;
const HISTORY_MAX_AGE_MS = 12 * 3_600_000;
const HISTORY_FROM = "2010-01-01";
export const REQUEST_BUDGET = 45;

export interface MarketStore {
  get(key: string): Promise<string | undefined>;
  put(entries: Array<[string, string]>): Promise<void>;
  /** Entries whose key starts with `prefix`, in key order. */
  scan(prefix: string): Promise<Array<[string, string]>>;
}

export class MemoryMarketStore implements MarketStore {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async put(entries: Array<[string, string]>) { for (const [key, value] of entries) this.values.set(key, value); }
  async scan(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix)).sort(([left], [right]) => (left < right ? -1 : 1));
  }
}

type StoredHistory = DailyHistory & {
  /** Unix ms of the last successful check. */
  checkedAt: number;
  failedAt?: number;
  distributionsAt?: number;
  name?: string;
};

type Security = RequestedSecurity & { key: string };

/** The latest Japannext trade seen for one security. */
type PtsTrade = {
  price: number;
  /** Cumulative session volume; a change means a new trade. */
  volume: number;
  /** Unix seconds: when the trade was first seen (file time), or the session start when unknown. */
  at: number;
  session: "pts_day" | "pts_night";
  /** `day:YYYY-MM-DD` or `night:YYYY-MM-DD`. */
  sessionKey: string;
};

const parseJson = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};

function hash(value: string) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16_777_619);
  return (result >>> 0).toString(36);
}

const withTimeout = <T>(task: Promise<T>, ms: number) => Promise.race([task, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
const isFund = (security: Security) => security.venueCode === "FUND";
const zoneOf = (security: Security) => (security.venueCode === "US" || security.venueCode === "USD_FUND" || (security.venueCode === "INDEX" && security.currency === "USD") ? "America/New_York" : "Asia/Tokyo");

/** The most recent session that should already have a final daily close. */
export function expectedLastSession(security: Security, nowMs: number) {
  const zone = zoneOf(security);
  const closeMinute = zone === "Asia/Tokyo" ? 15 * 60 + 45 : 16 * 60 + 30;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const part = (type: "hour" | "minute") => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const date = dateInZone(nowMs, zone);
  let candidate = part("hour") * 60 + part("minute") >= closeMinute ? date : addDays(date, -1);
  for (let guard = 0; guard < 7; guard += 1) {
    const weekday = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) break;
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

/** True when every overlapping date has the same close (±0.5%): the adjustment basis did not change. */
function sameBasis(stored: DailyHistory, incoming: DailyHistory) {
  const closes = new Map(stored.dates.map((date, index) => [date, stored.closes[index]]));
  let overlap = 0;
  for (let index = 0; index < incoming.dates.length; index += 1) {
    const previous = closes.get(incoming.dates[index]);
    if (previous == null) continue;
    overlap += 1;
    if (Math.abs(incoming.closes[index] / previous - 1) > 0.005) return false;
  }
  return overlap > 0;
}

/** Appends `incoming` (same basis) to `stored`: later dates replace, dividends/splits unite by date. */
function appendHistory(stored: StoredHistory, incoming: DailyHistory): StoredHistory {
  const start = incoming.dates[0] ?? "9999";
  const keep = stored.dates.findIndex((date) => date >= start);
  const cut = keep < 0 ? stored.dates.length : keep;
  const byDate = <T extends { date: string }>(left: T[], right: T[]) => [...new Map([...left, ...right].map((item) => [item.date, item])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const { failedAt: _failedAt, ...rest } = stored;
  return {
    ...rest,
    dates: [...stored.dates.slice(0, cut), ...incoming.dates],
    closes: [...stored.closes.slice(0, cut), ...incoming.closes],
    splits: byDate(stored.splits, incoming.splits),
    dividends: byDate(stored.dividends, incoming.dividends),
    fetchedAt: incoming.fetchedAt,
  };
}

export type MarketServiceOptions = {
  now?: () => number;
  seedCatalog?: () => Promise<string[]>;
  /** Called when history work remains after a request's upstream budget ran out. */
  scheduleContinuation?: () => void;
};

export class MarketService {
  private loaded?: Promise<void>;
  private catalog: string[] = [];
  private quotes = new Map<string, Quote>();
  private quotesAt = 0;
  private quoteFlight?: Promise<void>;
  private benchmarks = new Map<string, Benchmark>();
  private topix?: { at: number; failedAt?: number };
  private week = { at: 0, revision: "0", series: new Map<string, IntradaySeries>() };
  private weekFlight?: Promise<void>;
  /** `revision` moves only when a PTS series changed, so unchanged intraday series are not resent. */
  private pts = { at: 0, revision: 0, trades: new Map<string, PtsTrade>(), series: new Map<string, IntradaySeries>() };
  private ptsFlight?: Promise<void>;
  private histories = new Map<string, StoredHistory>();
  private historyFlight?: Promise<void>;
  private fundFlight?: Promise<void>;
  private historyRevision = "";
  private persisted = { at: 0, size: 0 };
  private readAt = 0;

  constructor(private store: MarketStore, private options: MarketServiceOptions = {}) {}

  private now() { return this.options.now?.() ?? Date.now(); }

  // ---- Catalog ------------------------------------------------------------------------------------

  private load() {
    this.loaded ??= (async () => {
      const stored = parseJson<unknown>(await this.store.get("catalog"));
      let ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : undefined;
      if (!ids) {
        const seed = this.options.seedCatalog ? await this.options.seedCatalog().catch(() => []) : [];
        ids = seed.flatMap((value) => { const security = normalizeRequestedSecurity(value.trim()); return security ? [marketKey(security.id)] : []; });
        await this.store.put([["catalog", JSON.stringify([...new Set(ids)].filter((id) => id !== FX_KEY).sort().slice(0, MAX_CATALOG))]]);
      }
      this.catalog = [...new Set(ids.map(marketKey))].filter((id) => id !== FX_KEY).sort().slice(0, MAX_CATALOG);
      for (const [key, value] of await this.store.scan("h4:")) {
        const record = parseJson<StoredHistory>(value);
        if (record?.dates) this.histories.set(key.slice(3), record);
      }
      const saved = parseJson<{ at: number; quotes: Quote[]; benchmarks: Benchmark[] }>(await this.store.get("q4"));
      for (const quote of saved?.quotes ?? []) this.quotes.set(quote.key, quote);
      for (const benchmark of saved?.benchmarks ?? []) this.benchmarks.set(benchmark.id, benchmark);
      const pts = parseJson<{ series: Record<string, [number[], number[]]>; trades?: Record<string, PtsTrade> }>(await this.store.get("pts4"));
      for (const [key, [times, prices]] of Object.entries(pts?.series ?? {})) this.pts.series.set(key, { times, prices });
      for (const [key, trade] of Object.entries(pts?.trades ?? {})) this.pts.trades.set(key, trade);
      this.updateHistoryRevision();
    })();
    return this.loaded;
  }

  async securities(): Promise<Security[]> {
    await this.load();
    return [FX_KEY, ...this.catalog].flatMap((key) => {
      const security = normalizeRequestedSecurity(key);
      return security ? [{ ...security, key }] : [];
    });
  }

  async register(values: string[]) {
    await this.load();
    const added: string[] = [];
    const rejected: string[] = [];
    for (const value of values) {
      const security = normalizeRequestedSecurity(value.trim());
      if (!security) { rejected.push(value); continue; }
      const key = marketKey(security.id);
      if (key === FX_KEY || this.catalog.includes(key) || added.includes(key)) continue;
      if (this.catalog.length + added.length >= MAX_CATALOG) { rejected.push(value); continue; }
      added.push(key);
    }
    if (added.length) {
      this.catalog = [...this.catalog, ...added].sort();
      await this.store.put([["catalog", JSON.stringify(this.catalog)]]);
      this.quotesAt = 0;
      this.week.at = 0;
    }
    return { added, rejected, size: this.catalog.length };
  }

  // ---- Quotes ---------------------------------------------------------------------------------------

  private async refreshQuotes(budget: Budget) {
    const now = this.now();
    const securities = (await this.securities()).filter((security) => !isFund(security));
    const rows = await fetchSpark([...securities.map((security) => security.providerSymbol), ...BENCHMARKS.map((item) => item.symbol)], "1d", "5m", budget);
    const seconds = Math.floor(now / 1000);
    for (const security of securities) {
      const row = rows.get(security.providerSymbol.toUpperCase());
      const quote = row ? quoteFromSpark(security.key, security, row, seconds) : null;
      if (quote) this.quotes.set(security.key, quote);
    }
    for (const benchmark of BENCHMARKS) {
      const row = rows.get(benchmark.symbol.toUpperCase());
      const value = row ? benchmarkFromSpark(benchmark, row, seconds) : null;
      if (value) this.benchmarks.set(benchmark.id, value);
    }
    if (rows.size) this.quotesAt = now;
    // Saved for restarts during an outage: at most once a minute, and whenever a security is added.
    if (now - this.persisted.at > 60_000 || this.quotes.size !== this.persisted.size) {
      this.persisted = { at: now, size: this.quotes.size };
      await this.store.put([["q4", JSON.stringify({ at: now, quotes: [...this.quotes.values()], benchmarks: [...this.benchmarks.values()] })]]);
    }
  }

  private async refreshTopix(budget: Budget) {
    const now = this.now();
    if (this.topix && now - (this.topix.failedAt ?? this.topix.at) < (this.topix.failedAt ? RETRY_MS / 6 : TOPIX_TTL_MS)) return;
    try {
      this.benchmarks.set("topix", await fetchTopix(budget, Math.floor(now / 1000)));
      this.topix = { at: now };
    } catch {
      this.topix = { at: this.topix?.at ?? 0, failedAt: now };
    }
  }

  // ---- Japannext PTS ---------------------------------------------------------------------------------

  private async refreshPts(budget: Budget) {
    const now = this.now();
    const window = ptsWindowAt(now);
    if (!window || now - this.pts.at < PTS_TTL_MS) return;
    this.pts.at = now;
    const result = await fetchPts(window, budget, now).catch(() => null);
    // A file last written before this session opened still holds the previous session.
    if (!result || result.at < window.start) return;
    const sessionKey = `${window.venue}:${window.sessionKey}`;
    const cutoff = result.at - PTS_KEEP_SECONDS;
    let changed = false;
    let seriesChanged = false;
    for (const key of this.catalog) {
      const symbol = /^sec-([0-9]{4}|[0-9]{3}[a-z])$/u.exec(key)?.[1]?.toUpperCase();
      const row = symbol ? result.rows.get(symbol) : undefined;
      if (!row) continue;
      const known = this.pts.trades.get(key);
      if (known?.sessionKey === sessionKey && known.volume === row.volume) continue;
      // A new trade is stamped with the file time. A day-session trade first seen now may predate the
      // TSE close, so it counts from the session start until its volume changes again.
      const at = known?.sessionKey === sessionKey || window.venue === "night" ? result.at : window.start;
      this.pts.trades.set(key, { price: row.price, volume: row.volume, at, session: window.session, sessionKey });
      changed = true;
      if (at !== result.at) continue;
      const series = this.pts.series.get(key) ?? { times: [], prices: [] };
      if (series.times.at(-1) !== at && (series.prices.at(-1) !== row.price || at - (series.times.at(-1) ?? 0) >= 600)) {
        series.times.push(at);
        series.prices.push(row.price);
        seriesChanged = true;
      }
      const start = series.times.findIndex((time) => time >= cutoff);
      this.pts.series.set(key, start <= 0 ? series : { times: series.times.slice(start), prices: series.prices.slice(start) });
    }
    if (seriesChanged) this.pts.revision = result.at;
    if (changed) {
      for (const [key, trade] of this.pts.trades) if (trade.at < cutoff) this.pts.trades.delete(key);
      await this.store.put([["pts4", JSON.stringify({
        series: Object.fromEntries([...this.pts.series].map(([key, series]) => [key, [series.times, series.prices]])),
        trades: Object.fromEntries(this.pts.trades),
      })]]);
    }
  }

  /**
   * After the TSE close, a Japannext trade made after it (within ±20% of the TSE price) becomes the
   * quote; the TSE close stays on the quote as its regular-session price.
   */
  private withPts(quote: Quote): Quote {
    if (quote.venue !== "TSE" || quote.session === "regular") return quote;
    const trade = this.pts.trades.get(quote.key);
    if (!trade || trade.at <= quote.time || this.now() - trade.at * 1000 > PTS_OVERLAY_MS) return quote;
    if (Math.abs(trade.price / quote.price - 1) > 0.2) return quote;
    return { ...quote, price: trade.price, time: trade.at, session: trade.session, venue: "JNX", regularPrice: quote.price, regularTime: quote.time };
  }

  // ---- Intraday (5 days, 15 minutes) ------------------------------------------------------------

  private async refreshWeek(budget: Budget) {
    const now = this.now();
    if (now - this.week.at < WEEK_TTL_MS) return;
    const securities = (await this.securities()).filter((security) => !isFund(security));
    const rows = await fetchSpark(securities.map((security) => security.providerSymbol), "5d", "15m", budget);
    if (!rows.size) return;
    for (const security of securities) {
      const row = rows.get(security.providerSymbol.toUpperCase());
      if (row?.times.length) this.week.series.set(security.key, { times: row.times, prices: row.prices });
    }
    this.week.at = now;
    this.week.revision = String(Math.floor(now / 1000));
  }

  private intradayFor(security: Security): IntradaySeries | null {
    if (isFund(security)) {
      const history = this.histories.get(security.key);
      if (!history?.dates.length) return null;
      const start = Math.max(0, history.dates.length - 8);
      return { times: history.dates.slice(start).map((date) => Date.parse(`${date}T15:00:00+09:00`) / 1000), prices: history.closes.slice(start) };
    }
    const week = this.week.series.get(security.key);
    const pts = this.pts.series.get(security.key);
    if (!pts?.times.length) return week ?? null;
    const last = week?.times.at(-1) ?? 0;
    const after = pts.times.findIndex((time) => time > last);
    if (after < 0) return week ?? null;
    return { times: [...(week?.times ?? []), ...pts.times.slice(after)], prices: [...(week?.prices ?? []), ...pts.prices.slice(after)] };
  }

  // ---- Funds --------------------------------------------------------------------------------------

  private async refreshFunds(budget: Budget) {
    const now = this.now();
    const funds = (await this.securities()).filter(isFund);
    for (const security of funds) {
      const record = this.histories.get(security.key);
      const recentlyFailed = Boolean(record?.failedAt && record.failedAt > record.checkedAt && now - record.failedAt < RETRY_MS / 6);
      if (record && (recentlyFailed || now - record.checkedAt < FUND_TTL_MS)) {
        const quote = fundQuote(security.key, record, record.fetchedAt, record.name);
        if (quote) this.quotes.set(security.key, quote);
        continue;
      }
      if (budget.remaining < 4) break;
      const seconds = Math.floor(now / 1000);
      try {
        const fetchFund = (from: string) => security.key === MONEX_FUND_ID
          ? fetchMonexFund(security.providerSymbol, security.key, budget, seconds)
          : fetchJapanFund(security.providerSymbol, security.key, from, budget, seconds);
        let fetched = await fetchFund(record?.dates.length ? addDays(record.dates.at(-1)!, -45) : HISTORY_FROM);
        let base = record?.dates.length ? record : undefined;
        if (base && !sameBasis(base, fetched.history)) {
          fetched = await fetchFund(HISTORY_FROM);
          base = undefined;
        }
        let next: StoredHistory = base
          ? { ...appendHistory(base, fetched.history), checkedAt: now }
          : { ...fetched.history, checkedAt: now, dividends: record?.dividends ?? [] };
        if (fetched.name) next.name = fetched.name;
        if (security.key !== MONEX_FUND_ID && now - (record?.distributionsAt ?? 0) > DISTRIBUTION_TTL_MS && budget.remaining >= 3) {
          const distributions = await fetchFundDistributions(security.providerSymbol, budget).catch(() => null);
          if (distributions) next = { ...next, dividends: [...new Map([...next.dividends, ...distributions].map((item) => [item.date, item])).values()].filter((item) => item.amount > 0).sort((a, b) => (a.date < b.date ? -1 : 1)), distributionsAt: now };
        }
        await this.saveHistory(next);
        const quote = fundQuote(security.key, next, seconds, next.name);
        if (quote) this.quotes.set(security.key, quote);
      } catch {
        if (record) await this.saveHistory({ ...record, failedAt: now });
        else this.histories.set(security.key, { key: security.key, currency: security.currency, dates: [], closes: [], splits: [], dividends: [], fetchedAt: 0, checkedAt: 0, failedAt: now });
      }
    }
  }

  // ---- Daily history ----------------------------------------------------------------------------

  private async saveHistory(record: StoredHistory) {
    this.histories.set(record.key, record);
    await this.store.put([[`h4:${record.key}`, JSON.stringify(record)]]);
    this.updateHistoryRevision();
  }

  private updateHistoryRevision() {
    const parts = [...this.histories.values()].filter((record) => record.dates.length)
      .map((record) => `${record.key}:${record.fetchedAt}:${record.dates.length}:${record.closes.at(-1)}:${record.splits.length}:${record.dividends.length}`)
      .sort();
    this.historyRevision = hash(parts.join("|"));
  }

  private historyDue(security: Security, now: number) {
    const record = this.histories.get(security.key);
    if (!record?.dates.length) return !record?.failedAt || now - record.failedAt > RETRY_MS;
    if (record.failedAt && record.failedAt > record.checkedAt && now - record.failedAt < RETRY_MS) return false;
    const age = now - record.checkedAt;
    if (age > HISTORY_MAX_AGE_MS) return true;
    // A quote that moved >35% from the last close after the last check: probably a new split.
    const quote = this.quotes.get(security.key);
    if (quote && quote.time * 1000 > record.checkedAt && Math.abs(quote.price / record.closes.at(-1)! - 1) > 0.35) return true;
    return age > 20 * 60_000 && record.dates.at(-1)! < expectedLastSession(security, now);
  }

  private async refreshHistory(budget: Budget) {
    const now = this.now();
    const securities = (await this.securities()).filter((security) => !isFund(security));
    const due = securities.filter((security) => this.historyDue(security, now))
      .sort((left, right) => (this.histories.get(left.key)?.checkedAt ?? 0) - (this.histories.get(right.key)?.checkedAt ?? 0));
    await Promise.all(Array.from({ length: Math.min(6, due.length) }, async () => {
      while (due.length && budget.remaining > 2) await this.refreshOneHistory(due.shift()!, budget, now);
    }));
    if (due.length) this.options.scheduleContinuation?.();
  }

  private async refreshOneHistory(security: Security, budget: Budget, now: number) {
    const record = this.histories.get(security.key);
    const seconds = Math.floor(now / 1000);
    try {
      if (record?.dates.length && now - record.checkedAt < 7 * 86_400_000) {
        const period1 = Math.floor(Date.parse(`${addDays(record.dates.at(-1)!, -14)}T00:00:00Z`) / 1000);
        const recent = await fetchChartHistory(security, security.key, period1, budget, seconds);
        const newSplit = recent.splits.some((split) => !record.splits.some((known) => known.date === split.date));
        if (!newSplit && sameBasis(record, recent)) {
          await this.saveHistory({ ...appendHistory(record, recent), checkedAt: now });
          return;
        }
        if (budget.remaining <= 1) return;
      }
      const period1 = Math.floor(Date.parse(`${HISTORY_FROM}T00:00:00Z`) / 1000);
      const full = await fetchChartHistory(security, security.key, period1, budget, seconds);
      await this.saveHistory({ ...full, checkedAt: now });
    } catch (error) {
      if (error instanceof Error && error.message === "subrequest_budget_exhausted") return;
      if (record?.dates.length) await this.saveHistory({ ...record, failedAt: now });
      else this.histories.set(security.key, { key: security.key, currency: security.currency, dates: [], closes: [], splits: [], dividends: [], fetchedAt: 0, checkedAt: 0, failedAt: now });
    }
  }

  // ---- Background work -------------------------------------------------------------------------------

  private background(budget: Budget) {
    const run = (flight: Promise<void> | undefined, task: () => Promise<void>, set: (value: Promise<void> | undefined) => void) => {
      if (flight) return flight;
      const promise = task().catch(() => undefined).finally(() => set(undefined));
      set(promise);
      return promise;
    };
    return Promise.all([
      run(this.fundFlight, () => this.refreshFunds(budget), (value) => { this.fundFlight = value; }),
      run(this.ptsFlight, async () => { await this.refreshPts(budget); await this.refreshTopix(budget); }, (value) => { this.ptsFlight = value; }),
      run(this.weekFlight, () => this.refreshWeek(budget), (value) => { this.weekFlight = value; }),
    ]).then(() => run(this.historyFlight, () => this.refreshHistory(budget), (value) => { this.historyFlight = value; }));
  }

  /** Starts (or joins) the shared quote refresh. */
  private refreshQuotesOnce(budget: Budget) {
    this.quoteFlight ??= this.refreshQuotes(budget).catch(() => undefined).finally(() => { this.quoteFlight = undefined; });
    return this.quoteFlight;
  }

  /** Cron and alarm entry point: quotes while someone is reading, then PTS, intraday, funds and history within one budget. */
  async tick(budget = new Budget(REQUEST_BUDGET)) {
    await this.load();
    const now = this.now();
    await Promise.all([
      now - this.readAt < READER_ACTIVE_MS && now - this.quotesAt > QUOTE_TTL_MS ? this.refreshQuotesOnce(budget) : undefined,
      this.background(budget),
    ]);
  }

  // ---- Responses ------------------------------------------------------------------------------------

  /** `reader: false` (health checks) does not keep the cron refreshing quotes. */
  async snapshot(options: { force?: boolean; intradayRevision?: string; budget?: Budget; reader?: boolean } = {}): Promise<SnapshotPayload> {
    await this.load();
    const budget = options.budget ?? new Budget(REQUEST_BUDGET);
    const now = this.now();
    if (options.reader !== false) this.readAt = now;
    const age = now - this.quotesAt;
    if (age > (options.force ? FORCED_TTL_MS : QUOTE_TTL_MS)) {
      const refresh = this.refreshQuotesOnce(budget);
      // Recent quotes are answered at once; the refresh lands in the next poll.
      if (options.force || age > QUOTE_SERVE_STALE_MS || !this.quotes.size) await withTimeout(refresh, QUOTE_WAIT_MS);
    }
    const background = this.background(budget);
    const securities = await this.securities();
    const cold = !this.week.series.size || securities.some((security) => isFund(security) && !this.quotes.has(security.key) && !this.histories.get(security.key)?.failedAt);
    if (cold) await withTimeout(background, COLD_WAIT_MS);
    const quotes = securities.flatMap((security) => {
      const quote = this.quotes.get(security.key);
      return quote ? [this.withPts(quote)] : [];
    });
    const benchmarks = [...this.benchmarks.values()];
    const intradayRevision = `${this.week.revision}.${this.pts.revision}.${this.historyRevision}`;
    const payload: SnapshotPayload = {
      version: MARKET_WIRE_VERSION,
      generatedAt: Math.floor(now / 1000),
      revision: "",
      catalog: [...this.catalog],
      quotes,
      benchmarks,
      historyRevision: this.historyRevision,
      intradayRevision,
    };
    if (options.intradayRevision !== intradayRevision) {
      payload.intraday = {};
      for (const security of securities) {
        const series = this.intradayFor(security);
        if (series?.times.length) payload.intraday[security.key] = packSeries(series);
      }
    }
    payload.revision = hash(JSON.stringify([quotes.map((quote) => [quote.key, quote.price, quote.time, quote.previousClose]), benchmarks.map((item) => [item.id, item.value, item.time]), this.catalog, intradayRevision]));
    return payload;
  }

  async history(from: string, budget = new Budget(REQUEST_BUDGET)): Promise<HistoryPayload> {
    await this.load();
    const securities = await this.securities();
    const missing = securities.some((security) => !this.histories.has(security.key));
    const work = Promise.all([
      this.fundFlight ?? (this.fundFlight = this.refreshFunds(budget).catch(() => undefined).finally(() => { this.fundFlight = undefined; })),
      this.historyFlight ?? (this.historyFlight = this.refreshHistory(budget).catch(() => undefined).finally(() => { this.historyFlight = undefined; })),
    ]);
    if (missing) await withTimeout(work, 20_000);
    const records: HistoryPayload["records"] = {};
    const pending: string[] = [];
    for (const security of securities) {
      const record = this.histories.get(security.key);
      if (record?.dates.length) records[security.key] = packHistory(record, from);
      else if (!record?.failedAt) pending.push(security.key);
    }
    return { version: MARKET_WIRE_VERSION, revision: this.historyRevision, generatedAt: Math.floor(this.now() / 1000), from, records, pending };
  }

  async health() {
    const payload = await this.snapshot({ reader: false });
    return { status: this.now() - this.quotesAt < 120_000 ? "ok" : "stale", quotes: payload.quotes.length, catalog: payload.catalog.length, ageSeconds: Math.round((this.now() - this.quotesAt) / 1000) };
  }
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...init.headers },
});

/** HTTP surface shared by the Durable Object (cloud) and the Next.js route (local). Authentication happens first. */
export async function serveMarket(request: Request, service: MarketService, options: { maxRegister: number }) {
  const url = new URL(request.url);
  const name = url.pathname.split("/").at(-1);
  try {
    if (name === "snapshot" && request.method === "GET") {
      const payload = await service.snapshot({ force: url.searchParams.get("refresh") === "1", intradayRevision: url.searchParams.get("intraday") ?? undefined });
      const etag = `"${payload.revision}"`;
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
      return json(payload, { headers: { ETag: etag } });
    }
    if (name === "history" && request.method === "GET") {
      const from = url.searchParams.get("from") ?? "";
      if (!/^(19|20)\d{2}-01-01$/u.test(from)) return json({ error: "invalid_history_from" }, { status: 400 });
      const payload = await service.history(from);
      const etag = `"${payload.revision}:${from}:${payload.pending.length}"`;
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
      return json(payload, { headers: { ETag: etag } });
    }
    if (name === "registry" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const ids = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { securityIds?: unknown }).securityIds : undefined;
      if (!Array.isArray(ids) || !ids.length || ids.length > options.maxRegister || ids.some((id) => typeof id !== "string" || id.length > 80)) {
        return json({ error: "invalid_market_registry" }, { status: 400 });
      }
      const result = await service.register(ids as string[]);
      return json(result, { status: result.rejected.length ? 422 : 200 });
    }
    if (name === "health" && request.method === "GET") return json(await service.health());
    return json({ error: "not_found" }, { status: 404 });
  } catch {
    return json({ error: "market_unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
  }
}
