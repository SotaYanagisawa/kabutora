"use client";

import { FX_KEY, type Benchmark, type DailyHistory, type IntradaySeries, type Quote } from "@kabutora/domain/market";
import type { Fx, MarketData } from "@kabutora/domain/portfolio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchHistory, fetchSnapshot, MARKET_HISTORY_KEY, MARKET_SNAPSHOT_KEY, MarketRequestError, onMarketCatalogChange, registerMarketSecurities, takePrefetchedSnapshot } from "@/lib/market/market-client";
import { parseHistoryPayload, parseSnapshotPayload, unpackHistory, unpackSeries, type HistoryPayload, type PackedSeries, type SnapshotPayload } from "@/lib/market/market-wire";
import { RESUME_REFRESH_MS } from "./constants";
import type { MarketLoadResult, MarketStatus } from "./types";

/**
 * Market data for the dashboard: one snapshot request (quotes, benchmarks, intraday) polled while
 * visible, and one history request refetched only when the server's history revision changes.
 * The last responses are kept in localStorage so a reopened app renders prices on the first frame.
 */

const SNAPSHOT_KEY = MARKET_SNAPSHOT_KEY;
const HISTORY_KEY = MARKET_HISTORY_KEY;
const CLOSED_MARKET_POLL_MS = 5 * 60_000;
const HISTORY_RETRY_MS = 5_000;
const HISTORY_MAX_RETRIES = 8;

type StoredSnapshot = { savedAt: number; etag: string | null; payload: SnapshotPayload; intraday: Record<string, PackedSeries> };
type StoredHistory = { savedAt: number; etag: string | null; payload: HistoryPayload };

function readStored<T>(key: string, enabled: boolean, check: (value: unknown) => T | null): T | null {
  if (!enabled || typeof window === "undefined") return null;
  try {
    return check(JSON.parse(window.localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* Storage is optional. */ }
  }
}

const storedSnapshot = (value: unknown): StoredSnapshot | null => {
  const item = value as Partial<StoredSnapshot> | null;
  const payload = parseSnapshotPayload(item?.payload);
  const intraday = parseSnapshotPayload({ ...item?.payload, intraday: item?.intraday })?.intraday ?? {};
  return payload && typeof item?.savedAt === "number" ? { savedAt: item.savedAt, etag: null, payload, intraday } : null;
};

const storedHistory = (value: unknown): StoredHistory | null => {
  const item = value as Partial<StoredHistory> | null;
  const payload = parseHistoryPayload(item?.payload);
  return payload && typeof item?.savedAt === "number" ? { savedAt: item.savedAt, etag: typeof item.etag === "string" ? item.etag : null, payload } : null;
};

const errorMessage = (error: unknown, fallback: string) => (error instanceof MarketRequestError ? error.message : fallback);

export type MarketDataOptions = {
  /** YYYY-01-01 of the earliest trade or watched security. */
  historyFrom: string;
  autoRefresh: boolean;
  /** Seconds between polls while a market session is open. */
  updateSeconds: number;
  persist: boolean;
  /** Local mode only: securities to add to the catalog in bulk. Cloud clients never send holdings. */
  registerIds?: string[];
};

export function useMarketData(options: MarketDataOptions) {
  const { historyFrom, autoRefresh, updateSeconds, persist } = options;
  const initialSnapshot = useMemo(() => readStored(SNAPSHOT_KEY, persist, storedSnapshot), []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialHistory = useMemo(() => {
    const stored = readStored(HISTORY_KEY, persist, storedHistory);
    return stored && stored.payload.from <= historyFrom ? stored : null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [snapshot, setSnapshot] = useState<SnapshotPayload | null>(initialSnapshot?.payload ?? null);
  const [intraday, setIntraday] = useState<Record<string, PackedSeries>>(initialSnapshot?.intraday ?? {});
  const [history, setHistory] = useState<HistoryPayload | null>(initialHistory?.payload ?? null);
  const [quoteStatus, setQuoteStatus] = useState<MarketStatus>(initialSnapshot ? "partial" : "loading");
  const [historyStatus, setHistoryStatus] = useState<MarketStatus>(initialHistory ? "partial" : "loading");
  const [marketError, setMarketError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);

  const snapshotRef = useRef({ etag: null as string | null, intradayRevision: initialSnapshot?.payload.intradayRevision ?? "", lastAt: 0, savedAt: 0 });
  const historyRef = useRef({ etag: initialHistory?.etag ?? null as string | null, revision: initialHistory?.payload.revision ?? "", from: initialHistory?.payload.from ?? "", retries: 0, inFlight: null as Promise<void> | null });
  const intradayRef = useRef(initialSnapshot?.intraday ?? {});
  const snapshotInFlight = useRef<Promise<MarketLoadResult> | null>(null);
  const historyFromRef = useRef(historyFrom);
  historyFromRef.current = historyFrom;

  const loadHistory = useCallback(async (force = false) => {
    if (historyRef.current.inFlight) return historyRef.current.inFlight;
    const from = historyFromRef.current;
    const reuse = !force && historyRef.current.from === from;
    const task = (async () => {
      setHistoryStatus((current) => (current === "ready" ? current : "loading"));
      try {
        const result = await fetchHistory(from, reuse ? historyRef.current.etag ?? undefined : undefined);
        if (result.status === 200) {
          historyRef.current = { ...historyRef.current, etag: result.etag, revision: result.payload.revision, from };
          setHistory(result.payload);
          if (persist) writeStored(HISTORY_KEY, { savedAt: Date.now(), etag: result.etag, payload: result.payload } satisfies StoredHistory);
          const pending = result.payload.pending.length > 0;
          setHistoryStatus(pending ? "partial" : "ready");
          setHistoryError(pending ? `${result.payload.pending.length}銘柄の履歴を準備しています` : "");
          if (pending && historyRef.current.retries < HISTORY_MAX_RETRIES) {
            historyRef.current.retries += 1;
            window.setTimeout(() => { void loadHistory(); }, HISTORY_RETRY_MS);
          } else if (!pending) historyRef.current.retries = 0;
        } else {
          setHistoryStatus("ready");
          setHistoryError("");
        }
      } catch (error) {
        setHistoryStatus((current) => (current === "loading" ? "error" : "partial"));
        setHistoryError(errorMessage(error, "価格履歴を取得できませんでした"));
      }
    })().finally(() => { historyRef.current.inFlight = null; });
    historyRef.current.inFlight = task;
    return task;
  }, [persist]);

  const applySnapshot = useCallback((payload: SnapshotPayload, etag: string | null) => {
    const receivedAt = Date.now();
    setClockOffset(payload.generatedAt * 1000 - receivedAt);
    setSnapshot(payload);
    setUpdatedAt(receivedAt);
    snapshotRef.current.etag = etag;
    if (payload.intraday) {
      intradayRef.current = payload.intraday;
      setIntraday(payload.intraday);
      snapshotRef.current.intradayRevision = payload.intradayRevision;
    }
    if (persist && (payload.intraday || receivedAt - snapshotRef.current.savedAt > 60_000)) {
      snapshotRef.current.savedAt = receivedAt;
      const { intraday: _omitted, ...rest } = payload;
      writeStored(SNAPSHOT_KEY, { savedAt: receivedAt, etag: null, payload: rest, intraday: intradayRef.current } satisfies StoredSnapshot);
    }
    if (payload.historyRevision && payload.historyRevision !== historyRef.current.revision) void loadHistory();
    return payload.quotes.length >= payload.catalog.length ? "updated" as const : "partial" as const;
  }, [loadHistory, persist]);

  const loadSnapshot = useCallback((force = false): Promise<MarketLoadResult> => {
    if (snapshotInFlight.current && !force) return snapshotInFlight.current;
    const task = (async (): Promise<MarketLoadResult> => {
      snapshotRef.current.lastAt = Date.now();
      try {
        const prefetched = force ? null : takePrefetchedSnapshot();
        const result = await (prefetched ?? fetchSnapshot({ force, intradayRevision: snapshotRef.current.intradayRevision, etag: snapshotRef.current.etag ?? undefined }));
        let outcome: MarketLoadResult = "updated";
        if (result.status === 200) {
          // A prefetched response may lack intraday for our revision; it always carries quotes.
          outcome = applySnapshot(result.payload, result.etag);
        } else setUpdatedAt(Date.now());
        setQuoteStatus(outcome === "updated" ? "ready" : "partial");
        setMarketError("");
        return outcome;
      } catch (error) {
        setQuoteStatus((current) => (current === "ready" || current === "partial" ? "partial" : "error"));
        setMarketError(errorMessage(error, "市場価格を取得できませんでした"));
        return "failed";
      }
    })().finally(() => { if (snapshotInFlight.current === task) snapshotInFlight.current = null; });
    snapshotInFlight.current = task;
    return task;
  }, [applySnapshot]);

  // First load: snapshot (possibly prefetched) and history in parallel.
  useEffect(() => {
    void loadSnapshot();
    void loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A new earliest year needs a wider history window.
  useEffect(() => {
    if (historyRef.current.from && historyFrom < historyRef.current.from) void loadHistory(true);
  }, [historyFrom, loadHistory]);

  // A newly registered security: refresh prices and history now.
  useEffect(() => onMarketCatalogChange(() => {
    void loadSnapshot(true);
    void loadHistory(true);
  }), [loadHistory, loadSnapshot]);

  // Local mode: the user's own machine registers every held security in one call.
  const registerKey = (options.registerIds ?? []).join(",");
  useEffect(() => {
    if (!options.registerIds?.length || !snapshot) return;
    const catalog = new Set(snapshot.catalog);
    const missing = options.registerIds.filter((id) => !catalog.has(id));
    if (missing.length) void registerMarketSecurities(missing).catch(() => false);
  }, [registerKey, snapshot?.catalog.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling while visible: the chosen interval during sessions, slower when every market is closed.
  const anySessionOpen = Boolean(snapshot?.quotes.some((quote) => quote.session !== "closed"));
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = anySessionOpen ? updateSeconds * 1000 : Math.max(updateSeconds * 1000, CLOSED_MARKET_POLL_MS);
    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "visible") return;
        void loadSnapshot().finally(() => schedule(interval));
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        if (timer != null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      const elapsed = Date.now() - snapshotRef.current.lastAt;
      if (elapsed >= RESUME_REFRESH_MS) void loadSnapshot().finally(() => schedule(interval));
      else schedule(Math.max(0, interval - elapsed));
    };
    if (document.visibilityState === "visible") schedule(Math.max(0, interval - (Date.now() - snapshotRef.current.lastAt)));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [anySessionOpen, autoRefresh, loadSnapshot, updateSeconds]);

  const refresh = useCallback(async (force = true) => {
    setIsRefreshing(true);
    try {
      void loadHistory();
      return await loadSnapshot(force);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadHistory, loadSnapshot]);

  // ---- Decoded structures for the engine -------------------------------------------------------
  const quotes = useMemo(() => new Map<string, Quote>((snapshot?.quotes ?? []).map((quote) => [quote.key, quote])), [snapshot]);
  const histories = useMemo(() => new Map<string, DailyHistory>(Object.entries(history?.records ?? {}).map(([key, record]) => [key, unpackHistory(key, record)])), [history]);
  const intradaySeries = useMemo(() => new Map<string, IntradaySeries>(Object.entries(intraday).map(([key, series]) => [key, unpackSeries(series)])), [intraday]);
  const data = useMemo<MarketData>(() => ({ quotes, history: histories, intraday: intradaySeries }), [histories, intradaySeries, quotes]);
  const fx = useMemo<Fx>(() => {
    const quote = quotes.get(FX_KEY);
    const daily = histories.get(FX_KEY);
    const usdJpy = snapshot?.benchmarks.find((item) => item.id === "usd-jpy");
    const now = quote?.price ?? usdJpy?.value ?? daily?.closes.at(-1) ?? null;
    const previous = quote?.previousClose ?? (usdJpy?.changeRatio != null && now ? now / (1 + usdJpy.changeRatio) : null) ?? now;
    return { now, previous, dates: daily?.dates ?? [], closes: daily?.closes ?? [], ...(intradaySeries.get(FX_KEY) ? { intraday: intradaySeries.get(FX_KEY) } : {}) };
  }, [histories, intradaySeries, quotes, snapshot?.benchmarks]);
  const benchmarks: Benchmark[] = useMemo(() => snapshot?.benchmarks ?? [], [snapshot?.benchmarks]);

  return {
    data,
    fx,
    benchmarks,
    catalog: snapshot?.catalog ?? [],
    quoteStatus,
    historyStatus,
    marketError,
    historyError,
    historyPending: history?.pending ?? [],
    updatedAt,
    clockOffset,
    isRefreshing,
    refresh,
  };
}

export type MarketDataState = ReturnType<typeof useMarketData>;
