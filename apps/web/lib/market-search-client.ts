import { getMarketAuthHeaders } from "./firebase-client";
import { readMarketApiResponse } from "./market-api-response";

type SearchPayload<T> = { results?: T[]; error?: string };
type CachedSearch = { expiresAt: number; results: unknown[] };

const SEARCH_CACHE_MS = 15 * 60 * 1000;
const searchCache = new Map<string, CachedSearch>();
const searchInFlight = new Map<string, Promise<unknown[]>>();

export async function searchMarketSecurities<T>(query: string, onNetworkRequest?: () => void): Promise<T[]> {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return [];
  const cached = searchCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.results as T[];

  let task = searchInFlight.get(normalized);
  if (!task) {
    onNetworkRequest?.();
    task = (async () => {
      const response = await fetch("/api/market/search", {
        method: "POST",
        cache: "no-store",
        headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ q: query.trim() }),
      });
      const payload = await readMarketApiResponse<SearchPayload<unknown>>(response, "銘柄検索の応答を確認できませんでした");
      if (!response.ok) throw new Error(payload.error ?? "銘柄を検索できませんでした");
      const results = payload.results ?? [];
      searchCache.set(normalized, { expiresAt: Date.now() + SEARCH_CACHE_MS, results });
      return results;
    })().finally(() => searchInFlight.delete(normalized));
    searchInFlight.set(normalized, task);
  }
  return task as Promise<T[]>;
}
