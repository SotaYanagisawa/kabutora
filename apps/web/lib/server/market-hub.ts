import { canonicalDomainSecurityId, Decimal, type CorporateAction, type DistributionEvent } from "@kabutora/domain";
import { japannextPtsWindowAt, normalizeJapanesePtsSymbol } from "../japannext-pts";
import { normalizeRequestedSecurity, type RequestedSecurity } from "../market-security";
import { japanMarketSession } from "../market-session";
import type { DistributionCoverage, ServerBenchmark, ServerRemoteQuote } from "../server-market-types";
import {
  BENCHMARKS,
  MONEX_FUND_ID,
  SPARK_BENCHMARK_SYMBOLS,
  benchmarkFromSpark,
  fetchFundQuote,
  fetchHistory,
  fetchJapannextFrame,
  fetchSpark,
  fetchTopix,
  quoteFromSpark,
  type PriceSeries,
  type PtsFrame,
  type SparkResult,
} from "./market-sources";

/**
 * The whole market backend: one shared catalog of at most 200 public symbols and a
 * snapshot that is rebuilt on demand from batched upstream calls. Every reader gets
 * the same catalog-wide data, so no request ever carries a user's symbol list.
 */
export const MAX_CATALOG = 200;
export const FX_SECURITY_ID = "sec-fx-usdjpy";
const SNAPSHOT_TTL_MS = 15_000;
const FORCED_TTL_MS = 3_000;
const SNAPSHOT_WAIT_MS = 8_000;
/** Fund pages, TOPIX and PTS refresh off the critical path; a cold object waits this long for them once. */
const COLD_SIDE_WAIT_MS = 1_500;
const WEEK_TTL_MS = 30 * 60_000;
const FUND_TTL_MS = 30 * 60_000;
const FUND_RETRY_MS = 5 * 60_000;
const FUNDS_PER_REFRESH = 8;
const TOPIX_TTL_MS = 5 * 60_000;
const PTS_TTL_MS = 60_000;
const PTS_OVERLAY_MAX_AGE_MS = 12 * 3_600_000;
const STORED_TTL_MS = { history: 12 * 3_600_000, distributions: 72 * 3_600_000 } as const;
const STORED_RETRY_MS = 30 * 60_000;
/** Workers Free allows 50 subrequests per invocation. */
const REQUEST_UPSTREAM_BUDGET = 36;

export interface MarketStore {
  get(key: string): Promise<string | undefined>;
  /** Entries with keys starting with `prefix` and >= `from`, in key order. */
  scan(prefix: string, from?: string): Promise<Array<[string, string]>>;
  put(entries: Array<[string, string]>): Promise<void>;
  appendFrame(frame: PtsFrame): Promise<void>;
  /** Frames for one PTS trading date (day and night venues), oldest first. */
  frames(sessionKey: string): Promise<PtsFrame[]>;
  latestFrame(): Promise<PtsFrame | undefined>;
}

export class MemoryMarketStore implements MarketStore {
  private values = new Map<string, string>();
  private ptsFrames: PtsFrame[] = [];
  async get(key: string) { return this.values.get(key); }
  async scan(prefix: string, from = prefix) {
    return [...this.values].filter(([key]) => key.startsWith(prefix) && key >= from).sort(([left], [right]) => left < right ? -1 : 1);
  }
  async put(entries: Array<[string, string]>) { for (const [key, value] of entries) this.values.set(key, value); }
  async appendFrame(frame: PtsFrame) { this.ptsFrames = [...this.ptsFrames.filter((item) => item.minute !== frame.minute), frame].slice(-2_000); }
  async frames(sessionKey: string) { return this.ptsFrames.filter((frame) => frame.sessionKey === sessionKey); }
  async latestFrame() { return this.ptsFrames.at(-1); }
}

export type MarketSnapshot = {
  generatedAt: string;
  revision: string;
  catalogKey: string;
  quotes: ServerRemoteQuote[];
  benchmarks: ServerBenchmark[];
  series: PriceSeries[];
  failures: Array<{ securityId: string; message: string }>;
};

type Built = { snapshot: MarketSnapshot; at: number; body: string; sideVersion: number };
type StoredKind = keyof typeof STORED_TTL_MS;
type HistoryMeta = { checkedAt: number; failedAt?: number; provider?: string; inceptionDate?: string; actions?: CorporateAction[] };
type DistributionEntry = { checkedAt: number; failedAt?: number; events?: DistributionEvent[]; actions?: CorporateAction[]; coverage?: DistributionCoverage };

/** cyrb53: a fast non-cryptographic content hash for ETags. */
export function contentHash(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const parseJson = <T>(value: string | undefined): T | undefined => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("market_timeout")), ms); })])
    .finally(() => clearTimeout(timer));
}

/** Delta-encoded series keep 200 symbols × 5 sessions small on the wire. */
export function encodeSeries(series: PriceSeries[], since?: number) {
  return series.flatMap((item) => {
    const start = since ? item.t.findIndex((time) => time >= since) : 0;
    if (start < 0 || start >= item.t.length) return [];
    const t = item.t.slice(start);
    return [{
      id: item.id,
      v: item.provider,
      ...(item.session ? { s: item.session } : {}),
      ...(item.venueCode ? { x: item.venueCode } : {}),
      t: t.map((time, index) => index ? time - t[index - 1] : time),
      p: item.p.slice(start),
    }];
  });
}

function encodeSnapshot(snapshot: MarketSnapshot, since?: number) {
  const { series, ...rest } = snapshot;
  return JSON.stringify({ schemaVersion: 2, full: !since, ...rest, series: encodeSeries(series, since) });
}

/** Five days of 15-minute bars, then today's 5-minute bars, then the quote itself. */
function mergeSparkSeries(week: SparkResult | undefined, day: SparkResult | undefined, quote: ServerRemoteQuote | null) {
  const firstDay = day?.t[0] ?? Number.POSITIVE_INFINITY;
  const t: number[] = [];
  const p: number[] = [];
  if (week) for (let index = 0; index < week.t.length; index += 1) if (week.t[index] < firstDay) { t.push(week.t[index]); p.push(week.p[index]); }
  if (day) { t.push(...day.t); p.push(...day.p); }
  const quoteTime = quote && quote.provider === "yahoo_spark" ? Math.floor(Date.parse(quote.marketTimestamp) / 1000) : NaN;
  if (Number.isFinite(quoteTime) && quoteTime > (t.at(-1) ?? 0)) { t.push(quoteTime); p.push(Number(quote!.price)); }
  return t.length ? { t, p } : null;
}

/** The Japannext session in progress, or null on weekends, holidays and between sessions. */
const ptsWindow = (now: number) => {
  const date = new Date(now);
  return japanMarketSession(date).isOpen ? japannextPtsWindowAt(date) : null;
};

/** After the TSE close, a newer Japannext trade is the latest Japanese price. */
function withPts(quote: ServerRemoteQuote, frame: PtsFrame | undefined, security: RequestedSecurity, now: number): ServerRemoteQuote {
  if (!frame || quote.session === "regular") return quote;
  const symbol = normalizeJapanesePtsSymbol(security.providerSymbol);
  const row = symbol ? frame.rows[symbol] : undefined;
  if (!row || !(Number(row[1]) > 0)) return quote;
  if (frame.sourceAt <= Date.parse(quote.marketTimestamp) || now - frame.sourceAt > PTS_OVERLAY_MAX_AGE_MS) return quote;
  if (new Decimal(row[0]).div(quote.price).sub(1).abs().gt("0.2")) return quote;
  const window = ptsWindow(now);
  const ageSeconds = (now - frame.sourceAt) / 1000;
  return {
    ...quote,
    price: row[0],
    session: window?.session ?? "closed",
    venueCode: "JNX",
    marketTimestamp: new Date(frame.sourceAt).toISOString(),
    provider: "japannext_pts_public",
    priceType: ageSeconds <= 900 ? "last_trade" : "delayed_last",
    freshness: !window ? "cached" : ageSeconds <= 120 ? "live" : ageSeconds <= 900 ? "near_live" : "delayed",
  };
}

const upstreamCost = (security: RequestedSecurity, kind: StoredKind) => security.venueCode !== "FUND" || security.id === MONEX_FUND_ID ? 1 : kind === "history" ? 6 : 2;

export class MarketHub {
  private built?: Built;
  private flight?: Promise<Built>;
  private dirty = false;
  private catalog?: string[];
  private week = { at: 0, data: new Map<string, SparkResult>() };
  private funds = new Map<string, { at: number; quote: ServerRemoteQuote; series: PriceSeries | null }>();
  private fundFailures = new Map<string, number>();
  private topix?: { at: number; value: ServerBenchmark };
  private pts = { checkedAt: 0, validators: {} as Record<string, { etag?: string | null; lastModified?: string | null }> };
  private storedFlights: Partial<Record<StoredKind, Promise<void>>> = {};
  /** Bumped when background fund/TOPIX/PTS data changes, so the next read rebuilds. */
  private sideVersion = 0;
  private sideFlight?: Promise<void>;

  constructor(private store: MarketStore, private options: { seedCatalog?: () => Promise<string[]>; now?: () => number } = {}) {}

  private now() { return this.options.now?.() ?? Date.now(); }

  async catalogIds() {
    if (this.catalog) return this.catalog;
    const stored = parseJson<unknown>(await this.store.get("catalog"));
    let ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : undefined;
    if (!ids) {
      const seed = this.options.seedCatalog ? await this.options.seedCatalog().catch(() => []) : [];
      ids = [...new Set(seed.flatMap((value) => {
        const security = normalizeRequestedSecurity(value.trim());
        return security ? [canonicalDomainSecurityId(security.id)] : [];
      }))].filter((id) => id !== FX_SECURITY_ID).sort().slice(0, MAX_CATALOG);
      await this.store.put([["catalog", JSON.stringify(ids)]]);
    }
    this.catalog = ids;
    return ids;
  }

  async securities() {
    const ids = [FX_SECURITY_ID, ...await this.catalogIds()];
    return ids.flatMap((id) => { const security = normalizeRequestedSecurity(id); return security ? [security] : []; });
  }

  async register(values: string[]) {
    const current = await this.catalogIds();
    const next = [...current];
    const added: string[] = [];
    const rejected: string[] = [];
    for (const value of values) {
      const security = normalizeRequestedSecurity(value.trim());
      if (!security) { rejected.push(value); continue; }
      const id = canonicalDomainSecurityId(security.id);
      if (id === FX_SECURITY_ID || next.includes(id)) continue;
      if (next.length >= MAX_CATALOG) { rejected.push(value); continue; }
      next.push(id);
      added.push(id);
    }
    if (added.length) {
      next.sort();
      await this.store.put([["catalog", JSON.stringify(next)]]);
      this.catalog = next;
      this.dirty = true;
      this.week.at = 0;
    }
    return { added, rejected, size: next.length };
  }

  /** Fresh within 15 s (3 s when forced); concurrent readers share one rebuild. */
  async snapshot(options: { force?: boolean } = {}): Promise<Built & { stale: boolean }> {
    if (!this.built) await this.restore();
    const ttl = options.force ? FORCED_TTL_MS : SNAPSHOT_TTL_MS;
    if (this.built && !this.dirty && this.built.sideVersion === this.sideVersion && this.now() - this.built.at < ttl) return { ...this.built, stale: false };
    this.flight ??= this.rebuild().finally(() => { this.flight = undefined; });
    try {
      return { ...await withTimeout(this.flight, SNAPSHOT_WAIT_MS), stale: false };
    } catch (error) {
      if (this.built) return { ...this.built, stale: true };
      throw error;
    }
  }

  encode(snapshot: MarketSnapshot, since?: number) {
    return encodeSnapshot(snapshot, since);
  }

  private async restore() {
    const saved = parseJson<{ generatedAt?: string; quotes?: ServerRemoteQuote[]; benchmarks?: ServerBenchmark[] }>(await this.store.get("snapshot"));
    if (!saved?.quotes) return;
    const snapshot: MarketSnapshot = { generatedAt: saved.generatedAt ?? new Date(0).toISOString(), revision: "restored", catalogKey: "", quotes: saved.quotes, benchmarks: saved.benchmarks ?? [], series: [], failures: [] };
    this.built ??= { snapshot, at: 0, body: encodeSnapshot(snapshot), sideVersion: -1 };
  }

  private async rebuild(): Promise<Built> {
    const now = this.now();
    this.dirty = false;
    const securities = await this.securities();
    const sparkSecurities = securities.filter((security) => security.venueCode !== "FUND");
    const funds = securities.filter((security) => security.venueCode === "FUND");
    const symbols = sparkSecurities.map((security) => security.providerSymbol);
    const weekDue = now - this.week.at > WEEK_TTL_MS;
    const side = this.refreshSide(funds, securities, now);
    // Wait briefly only when there is nothing at all to show; restored data covers restarts.
    const shown = new Set([...(this.built?.snapshot.quotes ?? []).map((quote) => quote.securityId), ...(this.built?.snapshot.benchmarks ?? []).map((benchmark) => benchmark.id)]);
    const cold = (!this.topix && !shown.has("topix")) || funds.some((fund) => !this.funds.has(fund.id) && !shown.has(fund.id));
    const [day, week] = await Promise.all([
      fetchSpark([...symbols, ...SPARK_BENCHMARK_SYMBOLS], "1d", "5m"),
      weekDue ? fetchSpark(symbols, "5d", "15m") : Promise.resolve(undefined),
      cold ? withTimeout(side, COLD_SIDE_WAIT_MS).catch(() => undefined) : undefined,
    ]);
    const sideVersion = this.sideVersion;
    const topix = this.topix?.value;
    const frame = await this.store.latestFrame();
    if (week?.size) this.week = { at: now, data: week };
    const previous = new Map((this.built?.snapshot.quotes ?? []).map((quote) => [quote.securityId, quote]));
    const quotes: ServerRemoteQuote[] = [];
    const series: PriceSeries[] = [];
    const failures: MarketSnapshot["failures"] = [];
    const keepPrevious = (id: string) => {
      const old = previous.get(id);
      if (old) quotes.push(old);
      failures.push({ securityId: id, message: old ? "market_quote_stale" : "market_quote_unavailable" });
    };
    for (const security of sparkSecurities) {
      const key = security.providerSymbol.toUpperCase();
      const spark = day.get(key);
      let quote = spark ? quoteFromSpark(security, spark, now) : null;
      if (quote && security.venueCode === "TSE") quote = withPts(quote, frame, security, now);
      if (quote) quotes.push(quote); else keepPrevious(security.id);
      const points = mergeSparkSeries(this.week.data.get(key), spark, quote);
      if (points) series.push({ id: security.id, provider: "yahoo_spark", ...points });
    }
    for (const fund of funds) {
      const entry = this.funds.get(fund.id);
      if (!entry) { keepPrevious(fund.id); continue; }
      quotes.push(entry.quote);
      if (entry.series) series.push(entry.series);
    }
    series.push(...await this.ptsSeries(frame, securities));
    const previousBenchmarks = new Map((this.built?.snapshot.benchmarks ?? []).map((benchmark) => [benchmark.id, benchmark]));
    const benchmarks = BENCHMARKS.flatMap((benchmark) => {
      const spark = benchmark.id === "topix" ? undefined : day.get(benchmark.symbol.toUpperCase());
      const value = benchmark.id === "topix" ? topix : spark ? benchmarkFromSpark(benchmark, spark, now) : undefined;
      const fallback = value ?? previousBenchmarks.get(benchmark.id);
      return fallback ? [fallback] : [];
    });
    const catalogKey = contentHash(securities.map((security) => security.id).join(","));
    const revision = contentHash(JSON.stringify([
      catalogKey,
      quotes.map((quote) => [quote.securityId, quote.price, quote.marketTimestamp, quote.session, quote.previousRegularClose ?? ""]),
      benchmarks.map((benchmark) => [benchmark.id, benchmark.value, benchmark.marketTimestamp]),
      series.map((item) => [item.id, item.t.length, item.t.at(-1), item.p.at(-1)]),
    ]));
    const snapshot: MarketSnapshot = { generatedAt: new Date(now).toISOString(), revision, catalogKey, quotes, benchmarks, series, failures };
    if (revision !== this.built?.snapshot.revision && quotes.length) {
      await this.store.put([["snapshot", JSON.stringify({ generatedAt: snapshot.generatedAt, quotes, benchmarks })]]);
    }
    this.built = { snapshot, at: now, body: encodeSnapshot(snapshot), sideVersion };
    return this.built;
  }

  /** Slow page scrapes (fund NAVs, TOPIX, PTS) never hold up the Yahoo batch refresh. */
  private refreshSide(funds: RequestedSecurity[], securities: RequestedSecurity[], now: number) {
    this.sideFlight ??= Promise.all([this.refreshFunds(funds, now), this.refreshTopix(now), this.refreshPts(now, securities)])
      .then((changes) => { if (changes.some(Boolean)) this.sideVersion += 1; })
      .catch(() => undefined)
      .finally(() => { this.sideFlight = undefined; });
    return this.sideFlight;
  }

  private async refreshTopix(now: number) {
    if (this.topix && now - this.topix.at < TOPIX_TTL_MS) return false;
    try {
      this.topix = { at: now, value: await fetchTopix(now) };
      return true;
    } catch {
      if (this.topix) this.topix.at = now - TOPIX_TTL_MS + 60_000;
      return false;
    }
  }

  private async refreshFunds(funds: RequestedSecurity[], now: number) {
    const due = funds.filter((fund) => {
      const entry = this.funds.get(fund.id);
      return (!entry || now - entry.at > FUND_TTL_MS) && now - (this.fundFailures.get(fund.id) ?? 0) > FUND_RETRY_MS;
    }).slice(0, FUNDS_PER_REFRESH);
    const results = await Promise.all(due.map(async (fund) => {
      try {
        this.funds.set(fund.id, { at: now, ...await fetchFundQuote(fund) });
        this.fundFailures.delete(fund.id);
        return true;
      } catch {
        this.fundFailures.set(fund.id, now);
        return false;
      }
    }));
    return results.some(Boolean);
  }

  private async refreshPts(now: number, securities: RequestedSecurity[]) {
    if (!ptsWindow(now) || now - this.pts.checkedAt <= PTS_TTL_MS) return false;
    return this.collectPts(now, securities).catch(() => false);
  }

  private ptsSymbols(securities: RequestedSecurity[]) {
    return new Map(securities.filter((security) => security.venueCode === "TSE").flatMap((security) => {
      const symbol = normalizeJapanesePtsSymbol(security.providerSymbol);
      return symbol ? [[symbol, security.id] as const] : [];
    }));
  }

  /** One Japannext request covers every catalog symbol; frames build the PTS chart. */
  async collectPts(now: number, securities: RequestedSecurity[]) {
    const window = ptsWindow(now);
    const symbols = this.ptsSymbols(securities);
    if (!window || !symbols.size) return false;
    this.pts.checkedAt = now;
    const result = await fetchJapannextFrame(window, new Set(symbols.keys()), now, this.pts.validators[window.venue]);
    if (result.status === "unchanged") return false;
    this.pts.validators[window.venue] = { etag: result.etag, lastModified: result.lastModified };
    if (now - result.frame.sourceAt > 15 * 60_000 || !Object.keys(result.frame.rows).length) return false;
    const latest = await this.store.latestFrame();
    if (latest?.sessionKey === result.frame.sessionKey && latest.venueCode === result.frame.venueCode && JSON.stringify(latest.rows) === JSON.stringify(result.frame.rows)) return false;
    await this.store.appendFrame(result.frame);
    this.sideVersion += 1;
    return true;
  }

  /** PTS bars for the latest trading date; only price changes become points. */
  private async ptsSeries(latest: PtsFrame | undefined, securities: RequestedSecurity[]): Promise<PriceSeries[]> {
    if (!latest) return [];
    const ids = this.ptsSymbols(securities);
    const result = new Map<string, PriceSeries>();
    for (const frame of await this.store.frames(latest.sessionKey)) {
      for (const [symbol, [last, volume]] of Object.entries(frame.rows)) {
        const id = ids.get(symbol);
        const price = Number(last);
        if (!id || !(Number(volume) > 0) || !(price > 0)) continue;
        const key = `${id}:${frame.venueCode}`;
        let item = result.get(key);
        if (!item) result.set(key, item = { id, provider: "japannext_pts_public", session: frame.session, venueCode: frame.venueCode, t: [], p: [] });
        if (item.p.at(-1) !== price) { item.t.push(frame.minute * 60); item.p.push(price); }
      }
    }
    for (const item of result.values()) {
      const end = latest.venueCode === item.venueCode ? latest.minute * 60 : undefined;
      if (end && end > item.t.at(-1)!) { item.t.push(end); item.p.push(item.p.at(-1)!); }
    }
    return [...result.values()];
  }

  /** Refreshes the stalest stored histories/distributions within one upstream budget. */
  private refreshStored(kind: StoredKind, securities: RequestedSecurity[], budget: number) {
    this.storedFlights[kind] ??= this.refreshStoredNow(kind, securities, budget).finally(() => { delete this.storedFlights[kind]; });
    return this.storedFlights[kind]!;
  }

  private async refreshStoredNow(kind: StoredKind, securities: RequestedSecurity[], budget: number) {
    const now = this.now();
    const prefix = kind === "history" ? "hmeta:" : "dist:";
    const entries = new Map((await this.store.scan(prefix)).map(([key, value]) => [key.slice(prefix.length), parseJson<HistoryMeta & DistributionEntry>(value)]));
    const due = securities
      .filter((security) => {
        const entry = entries.get(security.id);
        if (entry?.failedAt && now - entry.failedAt < STORED_RETRY_MS) return false;
        return !entry?.checkedAt || now - entry.checkedAt > STORED_TTL_MS[kind];
      })
      .sort((left, right) => (entries.get(left.id)?.checkedAt ?? 0) - (entries.get(right.id)?.checkedAt ?? 0));
    const picked: RequestedSecurity[] = [];
    let spent = 0;
    for (const security of due) {
      const cost = upstreamCost(security, kind);
      if (spent + cost > budget) continue;
      picked.push(security);
      spent += cost;
    }
    if (!picked.length) return;
    const result = await fetchHistory(picked, { distributionsOnly: kind === "distributions" });
    const writes: Array<[string, string]> = [];
    for (const failure of result.failures) writes.push([`${prefix}${failure.securityId}`, JSON.stringify({ ...entries.get(failure.securityId), failedAt: now })]);
    const succeeded = new Set(result.succeeded);
    const actionsFor = (id: string) => result.corporateActions.filter((action) => action.securityId === id);
    if (kind === "distributions") {
      for (const id of succeeded) {
        writes.push([`dist:${id}`, JSON.stringify({
          checkedAt: now,
          events: result.distributions.filter((event) => event.securityId === id),
          actions: actionsFor(id),
          coverage: result.coverage.find((item) => item.securityId === id),
        } satisfies DistributionEntry)]);
      }
    } else {
      const years = new Map<string, Map<string, Array<[string, string] | [string, string, string]>>>();
      for (const bar of result.bars) {
        if (!succeeded.has(bar.securityId)) continue;
        const byYear = years.get(bar.securityId) ?? new Map();
        years.set(bar.securityId, byYear);
        const rows = byYear.get(bar.date.slice(0, 4)) ?? [];
        byYear.set(bar.date.slice(0, 4), rows);
        rows.push(bar.adjustedClose ? [bar.date, bar.close, bar.adjustedClose] : [bar.date, bar.close]);
      }
      for (const id of succeeded) {
        const existing = new Map(await this.store.scan(`hist:${id}:`));
        for (const [year, rows] of years.get(id) ?? []) {
          const key = `hist:${id}:${year}`;
          const value = JSON.stringify(rows);
          if (existing.get(key) !== value) writes.push([key, value]);
        }
        const provider = result.bars.find((bar) => bar.securityId === id)?.provider;
        writes.push([`hmeta:${id}`, JSON.stringify({ checkedAt: now, provider, inceptionDate: result.inceptionDates[id], actions: actionsFor(id) } satisfies HistoryMeta)]);
      }
    }
    if (writes.length) await this.store.put(writes);
  }

  /** Catalog-wide daily closes from `from` (callers pass a year start), pre-serialized per year. */
  async history(from: string) {
    const securities = await this.securities();
    await withTimeout(this.refreshStored("history", securities, REQUEST_UPSTREAM_BUDGET), 25_000).catch(() => undefined);
    const fromYear = from.slice(0, 4);
    const metas = new Map((await this.store.scan("hmeta:")).map(([key, value]) => [key.slice(6), parseJson<HistoryMeta>(value)]));
    const series: string[] = [];
    const corporateActions: CorporateAction[] = [];
    const inceptionDates: Record<string, string> = {};
    const pending: string[] = [];
    for (const security of securities) {
      const meta = metas.get(security.id);
      if (!meta?.provider) { pending.push(security.id); continue; }
      corporateActions.push(...meta.actions ?? []);
      if (meta.inceptionDate) inceptionDates[security.id] = meta.inceptionDate;
      const rows = (await this.store.scan(`hist:${security.id}:`, `hist:${security.id}:${fromYear}`))
        .map(([, value]) => value.slice(1, -1)).filter(Boolean).join(",");
      if (rows) series.push(`${JSON.stringify(security.id)}:{"provider":${JSON.stringify(meta.provider)},"rows":[${rows}]}`);
    }
    return `{"generatedAt":${JSON.stringify(new Date(this.now()).toISOString())},"from":${JSON.stringify(from)},"series":{${series.join(",")}},"corporateActions":${JSON.stringify(corporateActions)},"inceptionDates":${JSON.stringify(inceptionDates)},"pending":${JSON.stringify(pending)}}`;
  }

  async distributions() {
    const securities = (await this.securities()).filter((security) => security.id !== FX_SECURITY_ID);
    await withTimeout(this.refreshStored("distributions", securities, REQUEST_UPSTREAM_BUDGET), 25_000).catch(() => undefined);
    const entries = new Map((await this.store.scan("dist:")).map(([key, value]) => [key.slice(5), parseJson<DistributionEntry>(value)]));
    const distributions: DistributionEvent[] = [];
    const corporateActions: CorporateAction[] = [];
    const coverage: DistributionCoverage[] = [];
    for (const security of securities) {
      const entry = entries.get(security.id);
      if (!entry?.coverage) continue;
      distributions.push(...entry.events ?? []);
      corporateActions.push(...entry.actions ?? []);
      coverage.push(entry.failedAt && this.now() - entry.checkedAt > STORED_TTL_MS.distributions ? { ...entry.coverage, status: "partial" } : entry.coverage);
    }
    return { generatedAt: new Date(this.now()).toISOString(), distributions, corporateActions, coverage };
  }

  /** Called every minute by the Worker cron: PTS frames plus background history/dividend refresh. */
  async tick() {
    const now = this.now();
    const securities = await this.securities();
    await this.collectPts(now, securities).catch(() => false);
    await this.refreshStored("history", securities, 20).catch(() => undefined);
    await this.refreshStored("distributions", securities.filter((security) => security.id !== FX_SECURITY_ID), 10).catch(() => undefined);
  }
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...init.headers },
});

/**
 * HTTP surface shared by the Durable Object (cloud) and the Next.js route (local Mac app).
 * Authentication happens before this function is called.
 */
export async function serveMarket(request: Request, hub: MarketHub, options: { maxRegister: number }) {
  const url = new URL(request.url);
  const name = url.pathname.split("/").at(-1);
  const serverTime = { "X-Market-Server-Time": new Date().toISOString() };
  try {
    if (name === "snapshot" && request.method === "GET") {
      const result = await hub.snapshot({ force: url.searchParams.get("refresh") === "1" });
      const etag = `"${result.snapshot.revision}"`;
      const headers = { ...serverTime, ETag: etag, "X-Market-Generated-At": result.snapshot.generatedAt, ...(result.stale ? { "X-Market-Stale": "1" } : {}) };
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ...headers, "Cache-Control": "private, no-store" } });
      const since = Number(url.searchParams.get("since"));
      const incremental = Number.isFinite(since) && since > 0 && url.searchParams.get("catalog") === result.snapshot.catalogKey;
      return new Response(incremental ? hub.encode(result.snapshot, since) : result.body, { headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
    }
    if (name === "history" && request.method === "GET") {
      const from = url.searchParams.get("from") ?? "";
      if (!/^(19|20)\d{2}-\d{2}-\d{2}$/u.test(from)) return json({ error: "invalid_history_from" }, { status: 400 });
      return new Response(await hub.history(from), { headers: { ...serverTime, "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
    }
    if (name === "distributions" && request.method === "GET") return json(await hub.distributions(), { headers: serverTime });
    if (name === "registry" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const ids = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { securityIds?: unknown }).securityIds : undefined;
      if (!Array.isArray(ids) || !ids.length || ids.length > options.maxRegister || ids.some((id) => typeof id !== "string" || id.length > 80)) {
        return json({ error: "invalid_market_registry" }, { status: 400 });
      }
      const result = await hub.register(ids as string[]);
      return json(result, { status: result.rejected.length ? 422 : 200 });
    }
    if (name === "health" && request.method === "GET") {
      const result = await hub.snapshot();
      return json({ status: result.stale ? "stale" : "ok", quotes: result.snapshot.quotes.length, generatedAt: result.snapshot.generatedAt, ageSeconds: Math.round((Date.now() - Date.parse(result.snapshot.generatedAt)) / 1000) }, { headers: serverTime });
    }
    return json({ error: "not_found" }, { status: 404 });
  } catch {
    return json({ error: "market_unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
  }
}
