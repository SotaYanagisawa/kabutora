"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { searchKnownJapanFunds } from "@/lib/market/japan-fund-catalog";
import { searchMarketSecurities } from "@/lib/market/market-search-client";
import {
  buildSecuritySearchIndex,
  isCurrentSearchRequest,
  mergeSecuritySearchResults,
  normalizeSecuritySearchTerm,
  searchSecurityIndex,
} from "@/lib/market/security-search";
import { searchEmbeddedCatalog } from "@/lib/market/stock-catalog";
import type { SearchSecurity } from "../dashboard/types";

export type SecuritySearchStatus = "idle" | "loading" | "ready" | "error";

type RemotePhase = "idle" | "debouncing" | "loading" | "ready" | "error";
type RemoteState = {
  query: string;
  items: SearchSecurity[];
  phase: RemotePhase;
};

const EMPTY_REMOTE_STATE: RemoteState = { query: "", items: [], phase: "idle" };

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSecuritySearch({
  securities,
  resultLimit,
  remoteDelayMs = 250,
  onNetworkRequest,
}: {
  securities: readonly SearchSecurity[];
  resultLimit: number;
  remoteDelayMs?: number;
  onNetworkRequest?: () => void;
}) {
  const [inputValue, setRawInputValue] = useState("");
  const [committedValue, setCommittedValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [remoteState, setRemoteState] = useState<RemoteState>(EMPTY_REMOTE_STATE);
  const [, startTransition] = useTransition();
  const composingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const currentQueryRef = useRef("");
  const onNetworkRequestRef = useRef(onNetworkRequest);
  onNetworkRequestRef.current = onNetworkRequest;

  const cancelRemoteWork = useCallback(() => {
    requestGenerationRef.current += 1;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const setInputValue = useCallback((nextValue: string) => {
    setRawInputValue(nextValue);
    if (!composingRef.current) {
      cancelRemoteWork();
      setCommittedValue(nextValue);
    }
  }, [cancelRemoteWork]);

  const beginComposition = useCallback(() => {
    composingRef.current = true;
    setIsComposing(true);
    cancelRemoteWork();
  }, [cancelRemoteWork]);

  const finishComposition = useCallback((nextValue: string) => {
    composingRef.current = false;
    setIsComposing(false);
    setRawInputValue(nextValue);
    cancelRemoteWork();
    setCommittedValue(nextValue);
  }, [cancelRemoteWork]);

  const clear = useCallback(() => {
    composingRef.current = false;
    setIsComposing(false);
    setRawInputValue("");
    setCommittedValue("");
    cancelRemoteWork();
    setRemoteState(EMPTY_REMOTE_STATE);
  }, [cancelRemoteWork]);

  const deferredValue = useDeferredValue(committedValue);
  const remoteQuery = deferredValue.trim();
  const inputQuery = normalizeSecuritySearchTerm(inputValue);
  const query = normalizeSecuritySearchTerm(deferredValue);
  currentQueryRef.current = query;

  const suppliedIndex = useMemo(() => buildSecuritySearchIndex(securities), [securities]);
  const localResults = useMemo(() => {
    if (!query) return [];
    const embedded = searchEmbeddedCatalog(query) as SearchSecurity[];
    const funds = searchKnownJapanFunds(query) as SearchSecurity[];
    const supplied = searchSecurityIndex(suppliedIndex, query, resultLimit);
    return mergeSecuritySearchResults([embedded, funds, supplied], resultLimit);
  }, [query, resultLimit, suppliedIndex]);

  useEffect(() => {
    cancelRemoteWork();
    if (!query) {
      setRemoteState(EMPTY_REMOTE_STATE);
      return;
    }

    const requestGeneration = requestGenerationRef.current;
    setRemoteState({ query, items: [], phase: "debouncing" });
    const timer = window.setTimeout(() => {
      if (!isCurrentSearchRequest(requestGeneration, query, requestGenerationRef.current, currentQueryRef.current)) return;
      timerRef.current = null;
      const controller = new AbortController();
      controllerRef.current = controller;
      setRemoteState({ query, items: [], phase: "loading" });

      void searchMarketSecurities<SearchSecurity>(remoteQuery, {
        signal: controller.signal,
        onNetworkRequest: () => onNetworkRequestRef.current?.(),
      }).then((items) => {
        if (!isCurrentSearchRequest(requestGeneration, query, requestGenerationRef.current, currentQueryRef.current)) return;
        startTransition(() => {
          setRemoteState({ query, items, phase: "ready" });
        });
      }).catch((error) => {
        if (isAbortError(error)) return;
        if (!isCurrentSearchRequest(requestGeneration, query, requestGenerationRef.current, currentQueryRef.current)) return;
        startTransition(() => {
          setRemoteState({ query, items: [], phase: "error" });
        });
      }).finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
      });
    }, remoteDelayMs);
    timerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (timerRef.current === timer) timerRef.current = null;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [cancelRemoteWork, query, remoteDelayMs, remoteQuery]);

  useEffect(() => () => cancelRemoteWork(), [cancelRemoteWork]);

  const queryIsCurrent = inputQuery === query;
  const mayShowCommittedResults = queryIsCurrent || isComposing;
  const matchingRemote = remoteState.query === query ? remoteState : EMPTY_REMOTE_STATE;
  const results = useMemo(() => {
    if (!query || !mayShowCommittedResults) return [];
    return mergeSecuritySearchResults([localResults, matchingRemote.items], resultLimit);
  }, [localResults, matchingRemote.items, mayShowCommittedResults, query, resultLimit]);

  let status: SecuritySearchStatus = "idle";
  if (query && mayShowCommittedResults) {
    if (localResults.length > 0) status = "ready";
    else if (matchingRemote.phase === "loading") status = "loading";
    else if (matchingRemote.phase === "ready") status = "ready";
    else if (matchingRemote.phase === "error") status = "error";
  }

  return {
    inputValue,
    inputQuery,
    query,
    results,
    status,
    isComposing,
    remotePending: matchingRemote.phase === "debouncing" || matchingRemote.phase === "loading",
    setInputValue,
    beginComposition,
    finishComposition,
    clear,
  };
}
