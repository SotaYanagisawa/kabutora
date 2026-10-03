"use client";

/** Network loading for dashboard market data; see `useMarketLoaders`. */

import { canonicalDomainSecurityId, type MarketBar } from "@kabutora/domain";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { writeMarketCache } from "@/lib/market/client-market-cache";
import { stableMarketErrorMessage } from "@/lib/market/market-api-response";
import { fetchMarketDistributions, fetchMarketHistory, fetchMarketSnapshot, onMarketCatalogChange, registerMarketSecurities } from "@/lib/market/market-client";
import { historyCoverage, missingHistoryRequirements, splitSecurityIds } from "@/lib/market/market-fetch-plan";
import { inspectMarketHistory } from "@/lib/market/market-history";
import { useVisibleInterval } from "@/lib/ui/page-visibility";
import {
  DISTRIBUTION_CACHE_KEY,
  DISTRIBUTION_NETWORK_REVALIDATE_MS,
  FX_SECURITY_ID,
  HISTORY_INTEGRITY_CHECK_MS,
  HISTORY_NETWORK_REVALIDATE_MS,
  RESUME_REFRESH_MS,
  seededActions,
} from "./constants";
import { mergeActions, mergeDistributionEvents } from "./helpers";
import { historyRequirementSignature } from "./market-requirements";
import type { MarketState } from "./use-market-state";
import type { DashboardProps, DistributionCachePayload, HistoryCacheMeta, MarketLoadResult, SearchSecurity, UpdateFrequency, View } from "./types";

const HISTORY_VIEWS: View[] = ["overview", "performance", "security", "dividends", "notifications"];
const MAX_MARKET_RETRIES = 6;

type LoaderOptions = Pick<DashboardProps, "persistenceMode" | "allowPersistentMarketCache"> & {
  market: MarketState;
  /** Comma-joined sorted ID lists from `market-requirements.ts`. */
  quoteSecurityIds: string;
  historySecurityIds: string;
  distributionSecurityIds: string;
  historyCoverageRequired: Map<string, string>;
  todayKey: string;
  transactionRevision: string;
  allSecurities: SearchSecurity[];
  view: View;
  autoRefresh: boolean;
  updateFrequency: UpdateFrequency;
  activeViewRef: MutableRefObject<View>;
  showToast: (message: string) => void;
};

/**
 * Network loading for market data: one shared snapshot request (quotes, benchmarks, intraday),
 * catalog-wide history and distribution reads filtered locally, automatic and manual refresh.
 */
export function useMarketLoaders({
  market, quoteSecurityIds, historySecurityIds, distributionSecurityIds, historyCoverageRequired, todayKey, transactionRevision, allSecurities,
  view, autoRefresh, updateFrequency, activeViewRef, showToast, persistenceMode = "local", allowPersistentMarketCache = true,
}: LoaderOptions) {
  const {
    quotes, historyBars, historyBarsRef, setHistoryBars, historyInceptionDates, historyInceptionDatesRef, setHistoryInceptionDates,
    corporateActions, corporateActionsRef, setCorporateActions, distributions, setDistributions, distributionCoverage, setDistributionCoverage,
    setDistributionStatus, setDistributionError, distributionCacheSavedAt, setDistributionCacheSavedAt, setQuoteStatus, setBenchmarkStatus,
    setHistoryStatus, historyRequested, setHistoryRequested, historyQuality, setHistoryQuality, historyCacheMeta, historyCacheMetaRef,
    setHistoryCacheMeta, setMarketError, setHistoryError, setHistoryHealth, marketCacheHydrated, setApiUsage, acceptTrustedServerTime,
    applyServerMarketSnapshot, persistHistory, quoteSecurityIdsRef,
  } = market;
  quoteSecurityIdsRef.current = quoteSecurityIds;
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const historyRequestInFlight = useRef(false);
  const historyReloadPending = useRef(false);
  const distributionRequestInFlight = useRef(false);
  const distributionReloadPending = useRef(false);
  const distributionAttemptKey = useRef("");
  const historyRequirementKey = useRef("");
  const transactionRevisionRef = useRef("");
  const manualRefreshInFlight = useRef<Promise<void> | null>(null);
  const marketStartupRunRef = useRef(false);

  const registeredMarketKeyRef = useRef("");
  /** The local Mac app's own server may know every held symbol; the cloud catalog only grows from search selections. */
  const ensureLocalMarketCatalog = useCallback(async () => {
    if (persistenceMode !== "local") return false;
    const ids = [...new Set(allSecurities.map((security) => security.id))].sort();
    const key = ids.join(",");
    if (!ids.length || key === registeredMarketKeyRef.current) return false;
    const registered = await registerMarketSecurities(ids.slice(0, 200), { notify: false }).catch(() => false);
    if (registered) registeredMarketKeyRef.current = key;
    return registered;
  }, [allSecurities, persistenceMode]);

  const marketRequestRef = useRef<Promise<MarketLoadResult> | null>(null);
  /** One request returns every quote, benchmark and intraday chart; concurrent callers share it. */
  const loadMarket = useCallback((force = false): Promise<MarketLoadResult> => {
    if (marketRequestRef.current && !force) return marketRequestRef.current;
    const requestedAt = new Date().toISOString();
    setApiUsage((current) => ({ ...current, quoteRequests: current.quoteRequests + 1, benchmarkRequests: current.benchmarkRequests + 1, lastQuoteRequest: requestedAt, lastBenchmarkRequest: requestedAt }));
    setQuoteStatus((current) => current === "ready" || current === "partial" ? current : "loading");
    const task = (async (): Promise<MarketLoadResult> => {
      try {
        // Newly registered local symbols need a fresh snapshot, not the reused one.
        const registered = await ensureLocalMarketCatalog();
        const snapshot = await fetchMarketSnapshot({ force: force || registered });
        return snapshot ? applyServerMarketSnapshot(snapshot) : "failed";
      } catch (error) {
        setQuoteStatus((current) => current === "ready" || current === "partial" ? "partial" : "error");
        setBenchmarkStatus((current) => current === "ready" || current === "partial" ? "partial" : "error");
        setMarketError(stableMarketErrorMessage(error, "市場価格を取得できませんでした"));
        return "failed";
      }
    })().finally(() => { if (marketRequestRef.current === task) marketRequestRef.current = null; });
    marketRequestRef.current = task;
    return task;
  }, [applyServerMarketSnapshot, ensureLocalMarketCatalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const marketRetryRef = useRef({ history: 0, distributions: 0 });
  const scheduleMarketRetry = useCallback((kind: "history" | "distributions", retry: () => void) => {
    // The server fills a newly added symbol's history within a few calls; retry briefly.
    if (marketRetryRef.current[kind] >= MAX_MARKET_RETRIES) return;
    marketRetryRef.current[kind] += 1;
    window.setTimeout(retry, 15_000);
  }, []);

  const needsHistoryBackfill = useCallback((bars: MarketBar[]) => missingHistoryRequirements(bars, historyCoverageRequired, historyInceptionDates, todayKey).length > 0, [historyCoverageRequired, historyInceptionDates, todayKey]);

  const loadHistory = useCallback(async () => {
    if (!historySecurityIds) return;
    if (historyRequestInFlight.current) {
      historyReloadPending.current = true;
      return;
    }
    historyRequestInFlight.current = true;
    const requestedIds = splitSecurityIds(historySecurityIds, Number.MAX_SAFE_INTEGER).flat();
    // Only the earliest year leaves the device; the response covers the whole public catalog.
    const earliest = [...historyCoverageRequired.values()].sort()[0] ?? todayKey;
    setApiUsage((current) => ({ ...current, historyRequests: current.historyRequests + 1, lastHistoryRequest: new Date().toISOString() }));
    setHistoryStatus("loading");
    setHistoryError("");
    try {
      const payload = await fetchMarketHistory(earliest);
      acceptTrustedServerTime(payload.generatedAt);
      // Catalog rows use canonical ids; key them to this portfolio's own ids.
      const idsByCanonical = new Map<string, string[]>();
      for (const securityId of requestedIds) {
        const canonical = canonicalDomainSecurityId(securityId);
        idsByCanonical.set(canonical, [...idsByCanonical.get(canonical) ?? [], securityId]);
      }
      const forPortfolio = <T extends { securityId: string }>(items: T[]) => items.flatMap((item) => (idsByCanonical.get(canonicalDomainSecurityId(item.securityId)) ?? [])
        .map((securityId) => securityId === item.securityId ? item : { ...item, securityId }));
      const incomingBars = forPortfolio(payload.bars);
      const incomingActions = forPortfolio(payload.corporateActions);
      const incomingInceptionDates = Object.fromEntries(Object.entries(payload.inceptionDates)
        .flatMap(([securityId, date]) => (idsByCanonical.get(canonicalDomainSecurityId(securityId)) ?? []).map((target) => [target, date] as const)));
      const nextInceptionDates = { ...historyInceptionDates, ...incomingInceptionDates };
      const pendingIds = requestedIds.filter((securityId) => payload.pending.includes(canonicalDomainSecurityId(securityId)));
      if (!incomingBars.length && !historyBars.length) throw new Error(pendingIds.length ? "履歴を準備しています" : "履歴を取得できませんでした");
      const inspected = inspectMarketHistory(historyBars, incomingBars, mergeActions(seededActions, corporateActions, incomingActions));
      const returnedIds = new Set(incomingBars.map((bar) => bar.securityId));
      const missingRequiredIds = missingHistoryRequirements(inspected.bars, historyCoverageRequired, nextInceptionDates);
      const coveredIds = historyCoverage(inspected.bars);
      const cachedFallbackIds = requestedIds.filter((securityId) => !returnedIds.has(securityId) && coveredIds.has(securityId));
      const failedIds = [...new Set([...missingRequiredIds, ...requestedIds.filter((securityId) => !returnedIds.has(securityId) && !cachedFallbackIds.includes(securityId))])];
      const savedAt = new Date().toISOString();
      historyBarsRef.current = inspected.bars;
      setHistoryBars(inspected.bars);
      historyInceptionDatesRef.current = nextInceptionDates;
      setHistoryInceptionDates(nextInceptionDates);
      corporateActionsRef.current = inspected.actions;
      setCorporateActions(inspected.actions);
      setHistoryQuality(inspected.quality);
      const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum };
      historyCacheMetaRef.current = nextMeta;
      setHistoryCacheMeta(nextMeta);
      setHistoryHealth({ requested: requestedIds.length, returned: returnedIds.size, failedIds, fallbackIds: cachedFallbackIds, updatedAt: savedAt });
      setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
      if (allowPersistentMarketCache) persistHistory(savedAt, inspected.quality.checksum, inspected.bars, inspected.actions, nextInceptionDates);
      setHistoryStatus(failedIds.length || cachedFallbackIds.length || inspected.quality.status === "warning" ? "partial" : "ready");
      const failedLabels = failedIds.map((securityId) => securityId === FX_SECURITY_ID ? "USD/JPY" : allSecurities.find((security) => security.id === securityId)?.displaySymbol ?? securityId).slice(0, 4);
      setHistoryError(failedIds.length
        ? `履歴不足: ${failedLabels.join("、")}${failedIds.length > failedLabels.length ? `ほか${failedIds.length - failedLabels.length}銘柄` : ""}`
        : inspected.quality.status === "warning" ? "履歴データの整合性警告を検出しました" : "");
      if (pendingIds.length) scheduleMarketRetry("history", () => setHistoryRequested(false));
      else marketRetryRef.current.history = 0;
    } catch (error) {
      const cachedIds = new Set(historyCoverage(historyBars).keys());
      const fallbackIds = requestedIds.filter((securityId) => cachedIds.has(securityId));
      setHistoryHealth({ requested: requestedIds.length, returned: 0, failedIds: requestedIds.filter((securityId) => !fallbackIds.includes(securityId)), fallbackIds, updatedAt: new Date().toISOString() });
      setHistoryStatus((current) => historyBars.length || current === "partial" ? "partial" : "error");
      setHistoryError(stableMarketErrorMessage(error, "履歴を取得できませんでした"));
    } finally {
      historyRequestInFlight.current = false;
      if (historyReloadPending.current) {
        historyReloadPending.current = false;
        setHistoryRequested(false);
      }
    }
  }, [acceptTrustedServerTime, allowPersistentMarketCache, allSecurities, corporateActions, historyBars, historyCoverageRequired, historyInceptionDates, historySecurityIds, persistHistory, scheduleMarketRetry, todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDistributions = useCallback(async () => {
    const requestedIds = splitSecurityIds(distributionSecurityIds, Number.MAX_SAFE_INTEGER).flat();
    if (!requestedIds.length) {
      setDistributionStatus("ready");
      return;
    }
    if (distributionRequestInFlight.current) {
      distributionReloadPending.current = true;
      return;
    }
    distributionRequestInFlight.current = true;
    setDistributionStatus("loading");
    setDistributionError("");
    try {
      const payload = await fetchMarketDistributions();
      const wanted = new Set(requestedIds.map(canonicalDomainSecurityId));
      const relevant = <T extends { securityId: string }>(items: T[]) => items.filter((item) => wanted.has(canonicalDomainSecurityId(item.securityId)));
      const nextEvents = mergeDistributionEvents(distributions, relevant(payload.distributions));
      const nextCoverage = [...new Map([...distributionCoverage, ...relevant(payload.coverage)]
        .map((item) => [canonicalDomainSecurityId(item.securityId), { ...item, securityId: canonicalDomainSecurityId(item.securityId) }])).values()];
      const coveredIds = new Set(nextCoverage.filter((item) => item.status === "ready" || item.status === "no_events").map((item) => item.securityId));
      const missingIds = requestedIds.filter((securityId) => !coveredIds.has(canonicalDomainSecurityId(securityId)));
      const savedAt = new Date().toISOString();
      setDistributions(nextEvents);
      setDistributionCoverage(nextCoverage);
      setCorporateActions((current) => mergeActions(seededActions, current, relevant(payload.corporateActions)));
      setDistributionCacheSavedAt(savedAt);
      setDistributionStatus(missingIds.length || nextCoverage.some((item) => item.status === "partial" || item.status === "error") ? "partial" : "ready");
      setDistributionError(missingIds.length ? `${missingIds.length}銘柄の配当カバレッジを確認中` : "");
      if (missingIds.length) scheduleMarketRetry("distributions", () => { distributionAttemptKey.current = ""; setDistributionCacheSavedAt(""); });
      else marketRetryRef.current.distributions = 0;
      if (allowPersistentMarketCache) void writeMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY, { schemaVersion: 1, savedAt, distributions: nextEvents, coverage: nextCoverage });
    } catch (error) {
      setDistributionStatus(distributions.length || distributionCoverage.length ? "partial" : "error");
      setDistributionError(stableMarketErrorMessage(error, "配当データを取得できませんでした"));
    } finally {
      distributionRequestInFlight.current = false;
      if (distributionReloadPending.current) {
        distributionReloadPending.current = false;
        setDistributionCacheSavedAt("");
      }
    }
  }, [allowPersistentMarketCache, distributionCoverage, distributionSecurityIds, distributions, scheduleMarketRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (marketStartupRunRef.current) return;
    marketStartupRunRef.current = true;
    void loadMarket(false);
  }, [loadMarket]);

  // Local app: newly held symbols are registered with the local server and priced at once.
  useEffect(() => {
    if (!marketStartupRunRef.current || persistenceMode !== "local") return;
    void loadMarket(false);
  }, [loadMarket, persistenceMode, quoteSecurityIds]);

  // A search selection added a symbol to the shared catalog.
  useEffect(() => onMarketCatalogChange(() => { void loadMarket(true); }), [loadMarket]);

  useEffect(() => {
    if (transactionRevisionRef.current && transactionRevisionRef.current !== transactionRevision) setHistoryRequested(false);
    transactionRevisionRef.current = transactionRevision;
  }, [transactionRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // History is loaded lazily for views that chart it, cache-first.
  useEffect(() => {
    if (!marketCacheHydrated || !HISTORY_VIEWS.includes(view) || historyRequested) return;
    setHistoryRequested(true);
    const cacheAge = historyCacheMeta?.savedAt ? Date.now() - new Date(historyCacheMeta.savedAt).getTime() : Number.POSITIVE_INFINITY;
    if (historyBars.length && cacheAge < HISTORY_NETWORK_REVALIDATE_MS && !historyCacheMeta?.integrityMismatch && !needsHistoryBackfill(historyBars)) {
      setHistoryStatus(historyQuality?.status === "warning" ? "partial" : "ready");
      setApiUsage((current) => ({ ...current, historyCacheHits: current.historyCacheHits + 1 }));
      return;
    }
    void loadHistory();
  }, [historyBars, historyCacheMeta, historyQuality, historyRequested, loadHistory, marketCacheHydrated, needsHistoryBackfill, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Distributions are loaded lazily for the dividends and security views.
  useEffect(() => {
    if (!distributionSecurityIds || (view !== "dividends" && view !== "security")) return;
    const requestedIds = splitSecurityIds(distributionSecurityIds, Number.MAX_SAFE_INTEGER).flat().map(canonicalDomainSecurityId);
    const coverageMap = new Map(distributionCoverage.map((item) => [canonicalDomainSecurityId(item.securityId), item]));
    const coverageIncomplete = requestedIds.some((securityId) => {
      const item = coverageMap.get(securityId);
      return !item || item.status === "partial" || item.status === "error";
    });
    const cacheAge = distributionCacheSavedAt ? Date.now() - new Date(distributionCacheSavedAt).getTime() : Number.POSITIVE_INFINITY;
    if (!coverageIncomplete && cacheAge < DISTRIBUTION_NETWORK_REVALIDATE_MS) {
      setDistributionStatus("ready");
      return;
    }
    if (distributionAttemptKey.current === distributionSecurityIds) return;
    distributionAttemptKey.current = distributionSecurityIds;
    void loadDistributions();
  }, [distributionCacheSavedAt, distributionCoverage, distributionSecurityIds, loadDistributions, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const requirementSignature = historyRequirementSignature(historyCoverageRequired, todayKey);
  useEffect(() => {
    if (historyRequirementKey.current && historyRequirementKey.current !== requirementSignature && needsHistoryBackfill(historyBars)) setHistoryRequested(false);
    historyRequirementKey.current = requirementSignature;
  }, [historyBars, needsHistoryBackfill, requirementSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodically re-verify the cached history checksum and revalidate stale history.
  const inspectLocalHistory = useCallback(() => {
    const inspected = inspectMarketHistory([], historyBars, corporateActions);
    setHistoryQuality(inspected.quality);
    setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
    if (inspected.quality.checksum !== historyCacheMeta?.checksum) {
      setHistoryBars(inspected.bars);
      setCorporateActions(inspected.actions);
      setHistoryCacheMeta((current) => current ? { ...current, checksum: inspected.quality.checksum, integrityMismatch: true } : current);
      setHistoryStatus("partial");
      setHistoryError("履歴キャッシュの整合性不一致を検出し、再取得しています");
      setHistoryRequested(false);
    }
    const cacheAge = historyCacheMeta?.savedAt ? Date.now() - new Date(historyCacheMeta.savedAt).getTime() : Number.POSITIVE_INFINITY;
    if (document.visibilityState === "visible" && cacheAge >= HISTORY_NETWORK_REVALIDATE_MS) setHistoryRequested(false);
  }, [corporateActions, historyBars, historyCacheMeta]); // eslint-disable-line react-hooks/exhaustive-deps
  useVisibleInterval(historyBars.length ? inspectLocalHistory : null, HISTORY_INTEGRITY_CHECK_MS, true);

  // Automatic refresh: the chosen interval during sessions, at least hourly when all markets are closed.
  const hasActiveSession = Object.values(quotes).some((quote) => quote.session !== "closed");
  const effectiveUpdateMinutes = hasActiveSession ? updateFrequency : Math.max(updateFrequency, 60);
  const lastAutoRefreshRef = useRef(Date.now());
  useEffect(() => {
    if (!autoRefresh) return;
    let timer: number | null = null;
    const intervalMs = effectiveUpdateMinutes * 60_000;
    const refresh = () => {
      lastAutoRefreshRef.current = Date.now();
      void loadMarket(false);
    };
    const scheduleNext = (delayMs: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "visible") return;
        refresh();
        scheduleNext(intervalMs);
      }, delayMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timer != null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      // Coming back to the app shows current prices right away; the request is cheap.
      const elapsed = Date.now() - lastAutoRefreshRef.current;
      if (elapsed >= RESUME_REFRESH_MS) {
        refresh();
        scheduleNext(intervalMs);
      } else {
        scheduleNext(Math.max(intervalMs - elapsed, 0));
      }
    };
    if (document.visibilityState === "visible") scheduleNext(intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoRefresh, effectiveUpdateMinutes, loadMarket]);

  /** Manual/pull refresh; resolves when the price refresh settles. */
  const refreshMarket = useCallback(() => {
    if (manualRefreshInFlight.current) return manualRefreshInFlight.current;
    setIsManualRefreshing(true);
    setMarketError("");
    setHistoryError("");
    // Chart and dividend reloads never hold up the price result.
    if (["overview", "watchlist", "performance", "security", "notifications"].includes(activeViewRef.current)) void loadHistory().catch(() => undefined);
    void loadDistributions().catch(() => undefined);
    const refreshTask = loadMarket(true)
      .then((result) => {
        showToast(result === "updated" ? "市場データを更新しました"
          : result === "partial" ? "一部の市場データを取得できませんでした。保存済み価格を表示しています"
          : "更新に失敗しました");
      })
      .finally(() => {
        manualRefreshInFlight.current = null;
        setIsManualRefreshing(false);
      });
    manualRefreshInFlight.current = refreshTask;
    return refreshTask;
  }, [activeViewRef, loadDistributions, loadHistory, loadMarket, showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  return { refreshMarket, isManualRefreshing, effectiveUpdateMinutes };
}
