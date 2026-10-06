"use client";

/** Market data state for the dashboard: quotes, benchmarks, intraday and daily history, distributions, browser cache, trusted clock. */

import { canonicalDomainSecurityId, domainSecurityIdVariants, type CorporateAction, type DistributionEvent, type IntradayBar, type MarketBar } from "@kabutora/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { readCompactQuotesCache, readMarketCache, writeCompactQuotesCache, writeMarketCache } from "@/lib/market/client-market-cache";
import { mergeIntradayBars, sanitizeIntradayBars } from "@/lib/market/intraday-cache";
import type { DistributionCoverage, ServerMarketSnapshot } from "@/lib/market/market-api-types";
import { resolveMarketClock, trustedMarketClockAnchor, type TrustedMarketClockAnchor } from "@/lib/market/market-clock";
import { daysBetween, splitSecurityIds } from "@/lib/market/market-fetch-plan";
import { inspectMarketHistory, packHistoryBars, unpackHistoryBars, type HistoryQuality } from "@/lib/market/market-history";
import { mergeBenchmarks, mergeQuoteRecords } from "@/lib/market/market-snapshot-merge";
import type { MarketSessionStatus } from "@/lib/market/market-session";
import { marketDateKey } from "@/lib/charts/chart-presentation";
import { syncPageVisibilityDataset, useVisibleInterval } from "@/lib/ui/page-visibility";
import {
  DISTRIBUTION_CACHE_KEY,
  HISTORY_CACHE_KEY,
  LEGACY_HISTORY_CACHE_KEYS,
  LEGACY_MARKET_CACHE_KEYS,
  MARKET_CACHE_KEY,
  PERFORMANCE_DERIVATION_VERSION,
  seededActions,
} from "./constants";
import { mergeActions, mergeDistributionEvents, packIntradayBars, unpackIntradayBars } from "./helpers";
import { quoteRecordWithVariants } from "./market-requirements";
import type {
  MarketLoadResult,
  Benchmark,
  DashboardProps,
  DistributionCachePayload,
  FetchHealth,
  HistoryCacheMeta,
  HistoryCachePayload,
  MarketCachePayload,
  MarketStatus,
  RemoteQuote,
} from "./types";

const EMPTY_HEALTH: FetchHealth = { requested: 0, returned: 0, failedIds: [], fallbackIds: [], updatedAt: null };
const CACHED_MARKET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_CACHE_SCHEMA_VERSION = 11;
const now = () => typeof performance === "undefined" ? 0 : performance.now();

export type ApiUsage = {
  quoteRequests: number; benchmarkRequests: number; historyRequests: number; searchRequests: number; historyCacheHits: number; integrityChecks: number;
  lastQuoteRequest: string | null; lastBenchmarkRequest: string | null; lastHistoryRequest: string | null; lastSearchRequest: string | null;
};

type StateOptions = Pick<DashboardProps, "initialServerTimeMs" | "initialMarketSessions" | "initialMarketSnapshot" | "allowPersistentMarketCache">;

/**
 * Public market data held by the dashboard (quotes, benchmarks, intraday, daily history,
 * corporate actions, distributions), its browser cache, and the trusted market clock.
 */
export function useMarketState({ initialServerTimeMs, initialMarketSessions = [], initialMarketSnapshot, allowPersistentMarketCache = true }: StateOptions) {
  const [quotes, setQuotes] = useState<Record<string, RemoteQuote>>(() => {
    const fromSnapshot = Object.fromEntries((initialMarketSnapshot?.quotes ?? []).map((quote) => [quote.securityId, quote]));
    if (Object.keys(fromSnapshot).length) return fromSnapshot;
    return allowPersistentMarketCache ? readCompactQuotesCache() : {};
  });
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>(() => initialMarketSnapshot?.benchmarks ?? []);
  const [intradayBars, setIntradayBars] = useState<IntradayBar[]>(() => initialMarketSnapshot?.intraday ? sanitizeIntradayBars(initialMarketSnapshot.intraday) : []);
  const [historyBars, setHistoryBars] = useState<MarketBar[]>([]);
  const [historyInceptionDates, setHistoryInceptionDates] = useState<Record<string, string>>({});
  const [corporateActions, setCorporateActions] = useState<CorporateAction[]>(seededActions);
  const [distributions, setDistributions] = useState<DistributionEvent[]>([]);
  const [distributionCoverage, setDistributionCoverage] = useState<DistributionCoverage[]>([]);
  const [distributionStatus, setDistributionStatus] = useState<MarketStatus>("idle");
  const [distributionError, setDistributionError] = useState("");
  const [distributionCacheSavedAt, setDistributionCacheSavedAt] = useState("");
  const [quoteStatus, setQuoteStatus] = useState<MarketStatus>(() => {
    if (initialMarketSnapshot?.quotes.length) return initialMarketSnapshot.refresh.status === "ready" ? "ready" : "partial";
    if (allowPersistentMarketCache && typeof window !== "undefined" && Object.keys(readCompactQuotesCache()).length) return "partial";
    return "loading";
  });
  const [benchmarkStatus, setBenchmarkStatus] = useState<MarketStatus>(initialMarketSnapshot?.benchmarks.length ? "ready" : "loading");
  const [historyStatus, setHistoryStatus] = useState<MarketStatus>("idle");
  const [historyRequested, setHistoryRequested] = useState(false);
  const [historyQuality, setHistoryQuality] = useState<HistoryQuality | null>(null);
  const [historyCacheMeta, setHistoryCacheMeta] = useState<HistoryCacheMeta | null>(null);
  const [marketError, setMarketError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [quoteHealth, setQuoteHealth] = useState<FetchHealth>(EMPTY_HEALTH);
  const [historyHealth, setHistoryHealth] = useState<FetchHealth>(EMPTY_HEALTH);
  const [marketCacheHydrated, setMarketCacheHydrated] = useState(false);
  const initialClockMs = Number.isFinite(initialServerTimeMs) ? initialServerTimeMs! : Date.now();
  const [sessionClock, setSessionClock] = useState<number | null>(() => Number.isFinite(initialClockMs) ? initialClockMs : null);
  const [serverMarketSessions, setServerMarketSessions] = useState<MarketSessionStatus[]>(initialMarketSessions);
  const [apiUsage, setApiUsage] = useState<ApiUsage>({ quoteRequests: 0, benchmarkRequests: 0, historyRequests: 0, searchRequests: 0, historyCacheHits: 0, integrityChecks: 0, lastQuoteRequest: null, lastBenchmarkRequest: null, lastHistoryRequest: null, lastSearchRequest: null });

  // Refs mirror the latest committed state for async loaders; render-time assignment keeps them current.
  const quotesRef = useRef(quotes);
  const benchmarksRef = useRef(benchmarks);
  const intradayBarsRef = useRef(intradayBars);
  const historyBarsRef = useRef(historyBars);
  const historyInceptionDatesRef = useRef(historyInceptionDates);
  const corporateActionsRef = useRef(corporateActions);
  const historyCacheMetaRef = useRef(historyCacheMeta);
  historyBarsRef.current = historyBars;
  historyInceptionDatesRef.current = historyInceptionDates;
  corporateActionsRef.current = corporateActions;
  historyCacheMetaRef.current = historyCacheMeta;
  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  useEffect(() => { benchmarksRef.current = benchmarks; }, [benchmarks]);
  useEffect(() => { intradayBarsRef.current = intradayBars; }, [intradayBars]);
  const sessionClockRef = useRef(sessionClock);
  const trustedClockRef = useRef<TrustedMarketClockAnchor | null>(trustedMarketClockAnchor(initialServerTimeMs ?? Number.NaN, now()));

  const acceptTrustedServerTime = useCallback((value: string | undefined) => {
    if (!value) return;
    const serverMs = Date.parse(value);
    if (!Number.isFinite(serverMs)) return;
    trustedClockRef.current = trustedMarketClockAnchor(serverMs, now());
    sessionClockRef.current = serverMs;
    setSessionClock(serverMs);
  }, []);

  const applyQuotes = useCallback((incoming: Record<string, RemoteQuote>, merge: (current: Record<string, RemoteQuote>, incoming: Record<string, RemoteQuote>) => Record<string, RemoteQuote>) => {
    const next = merge(quotesRef.current, incoming);
    quotesRef.current = next;
    setQuotes(next);
    return next;
  }, []);

  const mergeIntraday = useCallback((incoming: IntradayBar[]) => {
    const merged = mergeIntradayBars(intradayBarsRef.current, incoming);
    intradayBarsRef.current = merged;
    setIntradayBars(merged);
  }, []);

  const persistHistory = useCallback((savedAt: string, checksum: string, bars: MarketBar[], actions: CorporateAction[], inceptionDates: Record<string, string>) => {
    void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
      schemaVersion: HISTORY_CACHE_SCHEMA_VERSION,
      derivationVersion: PERFORMANCE_DERIVATION_VERSION,
      savedAt,
      checksum,
      series: packHistoryBars(bars),
      corporateActions: actions,
      inceptionDates,
    }, LEGACY_HISTORY_CACHE_KEYS);
  }, []);

  /** Records fresh quote prices as provisional daily bars so charts reach "today" before history catches up. */
  const logQuotesToHistory = useCallback((incomingQuotes: RemoteQuote[]) => {
    if (!incomingQuotes.length) return;
    const currentBars = historyBarsRef.current;
    if (!currentBars.length) return;
    const latestBarBySecurity = new Map<string, MarketBar>();
    const barBySecurityDate = new Map<string, MarketBar>();
    for (const bar of currentBars) {
      barBySecurityDate.set(`${bar.securityId}:${bar.date}`, bar);
      const prev = latestBarBySecurity.get(bar.securityId);
      if (!prev || bar.date > prev.date) latestBarBySecurity.set(bar.securityId, bar);
    }
    const quoteBars: MarketBar[] = [];
    for (const quote of incomingQuotes) {
      if (quote.validationStatus === "rejected") continue;
      const dateKey = quote.marketTimestamp
        ? (marketDateKey(quote.marketTimestamp, quote.exchangeMic, undefined, quote.currency, quote.venueCode === "US" ? "US" : "JP") || quote.marketTimestamp.slice(0, 10))
        : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const priceNum = Number(quote.price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
      for (const secId of new Set([quote.securityId, ...domainSecurityIdVariants(quote.securityId)])) {
        const latest = latestBarBySecurity.get(secId);
        if (!latest || daysBetween(latest.date, dateKey) > 5) continue;
        const existing = barBySecurityDate.get(`${secId}:${dateKey}`);
        // A quote already logged at this price changes nothing; skipping it spares a full history re-inspection.
        const logged = existing?.provider === "quote_log" && existing.close === String(priceNum) && existing.adjustedClose === String(priceNum);
        if ((!existing || existing.provider === "quote_log") && !logged) {
          quoteBars.push({ securityId: secId, date: dateKey, close: quote.price, adjustedClose: quote.price, provider: "quote_log" });
        }
      }
    }
    if (!quoteBars.length) return;
    const inspected = inspectMarketHistory(currentBars, quoteBars, corporateActionsRef.current);
    if (inspected.bars.length === currentBars.length && inspected.quality.checksum === historyCacheMetaRef.current?.checksum) return;
    historyBarsRef.current = inspected.bars;
    setHistoryBars(inspected.bars);
    setHistoryQuality(inspected.quality);
    const savedAt = new Date().toISOString();
    const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum };
    historyCacheMetaRef.current = nextMeta;
    setHistoryCacheMeta(nextMeta);
    if (allowPersistentMarketCache) persistHistory(savedAt, inspected.quality.checksum, inspected.bars, inspected.actions, historyInceptionDatesRef.current);
  }, [allowPersistentMarketCache, persistHistory]);

  /** IDs this portfolio follows (set by the dashboard each render); the snapshot covers the whole shared catalog. */
  const quoteSecurityIdsRef = useRef("");
  const applyServerMarketSnapshot = useCallback((snapshot: ServerMarketSnapshot): MarketLoadResult => {
    // An empty response still settles the status; previously loaded prices stay visible.
    const incomingQuotes = quoteRecordWithVariants(snapshot.quotes);
    const mergedQuotes = applyQuotes(incomingQuotes, mergeQuoteRecords);
    const mergedBenchmarks = mergeBenchmarks(benchmarksRef.current, snapshot.benchmarks);
    benchmarksRef.current = mergedBenchmarks;
    setBenchmarks(mergedBenchmarks);
    // Intraday bars stay keyed by canonical id; chart and notification lookups canonicalize.
    mergeIntraday(snapshot.intraday);
    logQuotesToHistory(snapshot.quotes);
    // Report health for this portfolio's symbols only.
    const requestedIds = splitSecurityIds(quoteSecurityIdsRef.current, Number.MAX_SAFE_INTEGER).flat();
    const failedIds = requestedIds.filter((securityId) => !mergedQuotes[securityId]);
    const fallbackIds = requestedIds.filter((securityId) => mergedQuotes[securityId] && !incomingQuotes[securityId]);
    const requested = new Set(requestedIds.map(canonicalDomainSecurityId));
    const suspect = snapshot.quotes.filter((quote) => quote.validationStatus === "suspect" && requested.has(canonicalDomainSecurityId(quote.securityId))).length;
    const partial = failedIds.length > 0 || fallbackIds.length > 0 || suspect > 0 || snapshot.refresh.status !== "ready";
    setQuoteHealth({ requested: requestedIds.length, returned: requestedIds.length - failedIds.length - fallbackIds.length, failedIds, fallbackIds, updatedAt: snapshot.savedAt });
    setQuoteStatus(partial ? "partial" : "ready");
    setBenchmarkStatus(mergedBenchmarks.length ? "ready" : "partial");
    setMarketError(failedIds.length ? `${failedIds.length}銘柄の現在値を取得できませんでした` : suspect ? `${suspect}銘柄で大きな変動を検出` : "");
    if (snapshot.marketSessions.length) setServerMarketSessions(snapshot.marketSessions);
    acceptTrustedServerTime(snapshot.generatedAt);
    return !snapshot.quotes.length ? "failed" : partial ? "partial" : "updated";
  }, [acceptTrustedServerTime, applyQuotes, logQuotesToHistory, mergeIntraday]);

  useEffect(() => {
    if (initialMarketSnapshot) applyServerMarketSnapshot(initialMarketSnapshot);
  }, [applyServerMarketSnapshot, initialMarketSnapshot]);

  // Hydrate from the browser market cache (IndexedDB), merging with anything already loaded.
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const [cachedMarket, cachedHistory, cachedDistributions] = allowPersistentMarketCache
        ? await Promise.all([
            readMarketCache<MarketCachePayload>(MARKET_CACHE_KEY, LEGACY_MARKET_CACHE_KEYS),
            readMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, LEGACY_HISTORY_CACHE_KEYS),
            readMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY),
          ])
        : [null, null, null];
      if (cancelled) return;
      if (cachedMarket) {
        try {
          const oldestUsable = Date.now() - CACHED_MARKET_MAX_AGE_MS;
          const cachedQuotes = Object.fromEntries(Object.entries(cachedMarket.quotes ?? {}).filter(([, quote]) => new Date(quote.marketTimestamp).getTime() >= oldestUsable));
          const cachedBenchmarks = (cachedMarket.benchmarks ?? []).filter((benchmark) => new Date(benchmark.marketTimestamp).getTime() >= oldestUsable);
          const cachedIntraday = cachedMarket.intradaySeries ? unpackIntradayBars(cachedMarket.intradaySeries) : cachedMarket.intraday ?? [];
          const mergedQuotes = applyQuotes(cachedQuotes, (current, cached) => mergeQuoteRecords(cached, current));
          const mergedBenchmarks = mergeBenchmarks(cachedBenchmarks, benchmarksRef.current);
          benchmarksRef.current = mergedBenchmarks;
          setBenchmarks(mergedBenchmarks);
          const mergedIntraday = mergeIntradayBars(cachedIntraday.filter((bar) => new Date(bar.timestamp).getTime() >= oldestUsable), intradayBarsRef.current);
          intradayBarsRef.current = mergedIntraday;
          setIntradayBars(mergedIntraday);
          if (Object.keys(mergedQuotes).length) setQuoteStatus("partial");
        } catch {
          // Ignore a malformed old snapshot; the network path will rebuild it.
        }
      }
      if (cachedHistory) {
        try {
          const cachedBars = cachedHistory.series ? unpackHistoryBars(cachedHistory.series) : cachedHistory.bars ?? [];
          const inspected = inspectMarketHistory([], cachedBars, mergeActions(seededActions, cachedHistory.corporateActions ?? []));
          const integrityMismatch = Boolean(cachedHistory.checksum && cachedHistory.checksum !== inspected.quality.checksum);
          const savedAt = cachedHistory.savedAt ?? "";
          historyBarsRef.current = inspected.bars;
          setHistoryBars(inspected.bars);
          historyInceptionDatesRef.current = cachedHistory.inceptionDates ?? {};
          setHistoryInceptionDates(cachedHistory.inceptionDates ?? {});
          corporateActionsRef.current = inspected.actions;
          setCorporateActions(inspected.actions);
          setHistoryQuality({ ...inspected.quality, status: integrityMismatch ? "warning" : inspected.quality.status });
          const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum, integrityMismatch };
          historyCacheMetaRef.current = nextMeta;
          setHistoryCacheMeta(nextMeta);
          if (inspected.bars.length) setHistoryStatus(integrityMismatch ? "partial" : "ready");
          setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
          // Rewrite only a cache that changed in normalization or format; an intact current one is left as is.
          const cacheCurrent = Boolean(cachedHistory.series) && cachedHistory.checksum === inspected.quality.checksum
            && cachedHistory.schemaVersion === HISTORY_CACHE_SCHEMA_VERSION && cachedHistory.derivationVersion === PERFORMANCE_DERIVATION_VERSION;
          if (!cacheCurrent) persistHistory(savedAt, inspected.quality.checksum, inspected.bars, inspected.actions, cachedHistory.inceptionDates ?? {});
          if (!cachedDistributions && cachedHistory.distributions?.length) {
            const legacyEvents = mergeDistributionEvents(cachedHistory.distributions);
            setDistributions(legacyEvents);
            setDistributionStatus("partial");
            void writeMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY, { schemaVersion: 1, savedAt, distributions: legacyEvents, coverage: [] });
          }
        } catch {
          // Corrupt legacy snapshots are ignored and replaced by a network fetch.
        }
      }
      if (cachedDistributions) {
        setDistributions(mergeDistributionEvents(cachedDistributions.distributions ?? []));
        setDistributionCoverage(cachedDistributions.coverage ?? []);
        setDistributionCacheSavedAt(cachedDistributions.savedAt ?? "");
        setDistributionStatus((cachedDistributions.coverage ?? []).some((item) => item.status === "error" || item.status === "partial") ? "partial" : "ready");
      }
      if (Object.keys(quotesRef.current).length && historyBarsRef.current.length) logQuotesToHistory(Object.values(quotesRef.current));
      setMarketCacheHydrated(true);
    };
    void hydrate();
    return () => { cancelled = true; };
  }, [allowPersistentMarketCache]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => syncPageVisibilityDataset(), []);

  // Advance the trusted market clock every 30 s while visible.
  const updateSessionClock = useCallback(() => {
    const resolved = resolveMarketClock(trustedClockRef.current, typeof performance === "undefined" ? Number.NaN : performance.now(), Date.now());
    if (resolved == null) return;
    sessionClockRef.current = resolved;
    setSessionClock(resolved);
  }, []);
  useEffect(updateSessionClock, [updateSessionClock]);
  useVisibleInterval(updateSessionClock, 30_000, true);

  // Persist live market data shortly after it changes.
  useEffect(() => {
    if (!allowPersistentMarketCache || !Object.keys(quotes).length) return;
    const timer = window.setTimeout(() => {
      writeCompactQuotesCache(quotes);
      void writeMarketCache<MarketCachePayload>(MARKET_CACHE_KEY, {
        schemaVersion: 7,
        savedAt: new Date().toISOString(),
        quotes,
        benchmarks,
        intradaySeries: packIntradayBars(intradayBars),
      }, LEGACY_MARKET_CACHE_KEYS);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [allowPersistentMarketCache, benchmarks, intradayBars, quotes]);

  return {
    quotes, quotesRef, applyQuotes,
    benchmarks, setBenchmarks, benchmarksRef,
    intradayBars, intradayBarsRef, mergeIntraday,
    historyBars, setHistoryBars, historyBarsRef,
    historyInceptionDates, setHistoryInceptionDates, historyInceptionDatesRef,
    corporateActions, setCorporateActions, corporateActionsRef,
    distributions, setDistributions,
    distributionCoverage, setDistributionCoverage,
    distributionStatus, setDistributionStatus,
    distributionError, setDistributionError,
    distributionCacheSavedAt, setDistributionCacheSavedAt,
    quoteStatus, setQuoteStatus,
    benchmarkStatus, setBenchmarkStatus,
    historyStatus, setHistoryStatus,
    historyRequested, setHistoryRequested,
    historyQuality, setHistoryQuality,
    historyCacheMeta, setHistoryCacheMeta, historyCacheMetaRef,
    marketError, setMarketError,
    historyError, setHistoryError,
    quoteHealth, setQuoteHealth,
    historyHealth, setHistoryHealth,
    marketCacheHydrated,
    sessionClock, sessionClockRef,
    serverMarketSessions, setServerMarketSessions,
    apiUsage, setApiUsage,
    quoteSecurityIdsRef, acceptTrustedServerTime, logQuotesToHistory, applyServerMarketSnapshot, persistHistory,
  };
}

export type MarketState = ReturnType<typeof useMarketState>;
