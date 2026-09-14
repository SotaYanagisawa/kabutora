import { getMarketAuthHeaders } from "./firebase-client";
import { readMarketApiResponse } from "./market-api-response";
import { timeoutSignal } from "./operation-deadline";

type SearchPayload<T> = { results?: T[]; error?: string };
type CachedSearch = { expiresAt: number; results: unknown[] };

const SEARCH_CACHE_MS = 15 * 60 * 1000;
const searchCache = new Map<string, CachedSearch>();
const searchInFlight = new Map<string, Promise<unknown[]>>();

type SearchOptions = {
  signal?: AbortSignal;
  onNetworkRequest?: () => void;
};

export async function searchMarketSecurities<T>(
  query: string,
  optionsOrCallback?: SearchOptions | (() => void),
): Promise<T[]> {
  const options = typeof optionsOrCallback === "function" ? { onNetworkRequest: optionsOrCallback } : optionsOrCallback ?? {};
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return [];
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  const cached = searchCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.results as T[];

  // Cancellable interactive searches own their request. Background callers may
  // still coalesce identical queries without allowing one caller to cancel all.
  let task = options.signal ? undefined : searchInFlight.get(normalized);
  if (!task) {
    options.onNetworkRequest?.();
    task = (async () => {
      const response = await fetch("/api/market/search", {
        method: "POST",
        cache: "no-store",
        headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ q: query.trim() }),
        signal: options.signal ?? timeoutSignal(4_000),
      });
      const payload = await readMarketApiResponse<SearchPayload<unknown>>(response, "銘柄検索の応答を確認できませんでした");
      if (!response.ok) throw new Error(payload.error ?? "銘柄を検索できませんでした");
      const results = payload.results ?? [];
      searchCache.set(normalized, { expiresAt: Date.now() + SEARCH_CACHE_MS, results });
      return results;
    })().finally(() => { if (!options.signal) searchInFlight.delete(normalized); });
    if (!options.signal) searchInFlight.set(normalized, task);
  }
  return task as Promise<T[]>;
}
