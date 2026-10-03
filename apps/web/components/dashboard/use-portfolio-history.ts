"use client";

import { PortfolioHistoryCalculator } from "@/lib/portfolio/domain-worker-client";
import type { PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import { emptyPortfolioCalculation, type HistoryDataset, type PortfolioCalculationResult } from "@/lib/portfolio/portfolio-history-calculation";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Seed } from "./types";

const FILTERS = ["ALL", "JP", "US", "FUNDS_INDEXES"] as const;
type SummaryInput = { transactions: Seed["transactions"]; currency: "JPY" | "USD" };
type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type Options = {
  dataset: HistoryDataset;
  /** Per-filter transaction selection and display currency. */
  summaryViewInputs: Map<PortfolioFilter, SummaryInput>;
  activeFilter: PortfolioFilter;
  brokerFilter: string;
  todayKey: string;
  workspaceRef: MutableRefObject<HTMLElement | null>;
};

/**
 * Runs portfolio history/summary reconstruction in the domain worker. Results are cached per
 * filter selection for the exact dataset that produced them; after the active selection completes,
 * the other market filters are pre-computed during idle time so filter switches are instant.
 */
export function usePortfolioHistory({ dataset, summaryViewInputs, activeFilter, brokerFilter, todayKey, workspaceRef }: Options) {
  const activeInput = summaryViewInputs.get(activeFilter)!;
  const request = useMemo(() => ({ dataset, selection: {
    transactionIds: activeInput.transactions.map((item) => item.id), throughDate: todayKey, currency: activeInput.currency, reconcile: activeFilter === "ALL",
  } }), [activeFilter, activeInput, dataset, todayKey]);
  const selectionKeyFor = (filter: PortfolioFilter, currency: "JPY" | "USD") => `${currency}:${filter}:${brokerFilter}:${todayKey}`;
  const selectionKey = selectionKeyFor(activeFilter, activeInput.currency);
  const cacheRef = useRef<Map<string, { dataset: HistoryDataset; result: PortfolioCalculationResult }>>(new Map());
  const latestDatasetRef = useRef(dataset);
  latestDatasetRef.current = dataset;
  const calculatorRef = useRef<PortfolioHistoryCalculator | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [completed, setCompleted] = useState<{ request: typeof request; result: PortfolioCalculationResult; failed: boolean } | null>(null);
  // A ref (not state): the flag is written straight to the DOM so preloading never re-renders the dashboard.
  const preloadedRef = useRef(false);

  // A selection cache is only valid for the exact market/history dataset that
  // produced it. Reusing a JP/US result after fresh quotes arrive makes the
  // filter appear stuck until the user changes it again.
  const cached = cacheRef.current.get(selectionKey);
  const activeResult = completed?.request === request ? completed.result : (cached?.dataset === request.dataset ? cached.result : null);

  useEffect(() => {
    const calculator = new PortfolioHistoryCalculator();
    calculatorRef.current = calculator;
    return () => { calculator.dispose(); calculatorRef.current = null; };
  }, []);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const run = () => {
      controller?.abort();
      if (!active || document.visibilityState === "hidden" || !calculatorRef.current) return;
      const hit = cacheRef.current.get(selectionKey);
      if (hit && hit.dataset === request.dataset) {
        setCompleted({ request, result: hit.result, failed: false });
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      void calculatorRef.current.calculate(request.dataset, request.selection, signal).then((result) => {
        if (!active || signal.aborted) return;
        if (latestDatasetRef.current === request.dataset) cacheRef.current.set(selectionKey, { dataset: request.dataset, result });
        setCompleted({ request, result, failed: false });
      }).catch((error: unknown) => {
        if (active && !signal.aborted && !(error instanceof Error && error.name === "AbortError")) setCompleted({ request, result: emptyPortfolioCalculation, failed: true });
      });
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", run);
    };
  }, [request, attempt, selectionKey]);

  // Pre-compute the other filters in the background once the active one is ready.
  useEffect(() => {
    const markPreloaded = (ready: boolean) => {
      preloadedRef.current = ready;
      if (workspaceRef.current) workspaceRef.current.dataset.marketViewsPreloaded = String(ready);
    };
    markPreloaded(false);
    if (!activeResult || completed?.failed || typeof Worker === "undefined" || document.visibilityState === "hidden") return;
    const pending = FILTERS.filter((filter) => {
      if (filter === activeFilter) return false;
      const input = summaryViewInputs.get(filter)!;
      return cacheRef.current.get(selectionKeyFor(filter, input.currency))?.dataset !== dataset;
    });
    if (!pending.length) return markPreloaded(true);
    const idleWindow = window as IdleWindow;
    let active = true;
    let controller: AbortController | null = null;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const scheduleNext = () => {
      if (!active) return;
      if (!pending.length) return markPreloaded(true);
      const start = () => { void warmNext(); };
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(start, { timeout: 120 });
      else timeoutId = window.setTimeout(start, 20);
    };
    const warmNext = async () => {
      if (!active || document.visibilityState === "hidden" || !calculatorRef.current) return;
      const filter = pending.shift();
      if (!filter) return;
      const input = summaryViewInputs.get(filter)!;
      const key = selectionKeyFor(filter, input.currency);
      if (cacheRef.current.get(key)?.dataset !== dataset) {
        controller = new AbortController();
        try {
          const result = await calculatorRef.current.calculate(dataset, {
            transactionIds: input.transactions.map((transaction) => transaction.id),
            throughDate: todayKey,
            currency: input.currency,
            reconcile: filter === "ALL",
          }, controller.signal, "background");
          if (active && latestDatasetRef.current === dataset) cacheRef.current.set(key, { dataset, result });
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) console.warn("[MARKET_VIEW_PRELOAD_FAILED]", error);
        }
      }
      scheduleNext();
    };
    scheduleNext();
    return () => {
      active = false;
      controller?.abort();
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [activeResult, activeFilter, brokerFilter, completed?.failed, dataset, summaryViewInputs, todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    /** Result for the current request, or null while the worker is still calculating. */
    activeResult,
    /** Most recent completed result (possibly for a previous request). */
    completed,
    failed: completed?.request === request && completed.failed,
    retry: () => setAttempt((value) => value + 1),
    preloadedRef,
    diagnostics: () => calculatorRef.current?.diagnostics() ?? { pending: 0, maxPending: 0, barCopies: 0 },
  };
}
