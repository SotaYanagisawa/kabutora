import { getMarketAuthHeaders } from "../sync/firebase-client";
import { timeoutSignal } from "../ui/operation-deadline";
import { parseHistoryPayload, parseSnapshotPayload, type HistoryPayload, type SnapshotPayload } from "./market-wire";

/** The only browser transport for /api/market/*. */

export class MarketRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MarketRequestError";
  }
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 15_000) {
  let headers: Record<string, string>;
  try {
    headers = await getMarketAuthHeaders();
  } catch {
    throw new MarketRequestError("認証を確認できませんでした");
  }
  try {
    return await fetch(path, { cache: "no-store", ...init, headers: { ...headers, ...init.headers as Record<string, string> }, signal: init.signal ?? timeoutSignal(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" && init.signal?.aborted) throw error;
    throw new MarketRequestError(typeof navigator !== "undefined" && !navigator.onLine ? "オフラインです" : "市場データサーバーに接続できませんでした");
  }
}

function failure(response: Response, fallback: string) {
  if (response.status === 401 || response.status === 403) return new MarketRequestError("市場データの認証に失敗しました。再サインインしてください", response.status);
  if (response.status === 429) return new MarketRequestError("市場データの取得が混み合っています", response.status);
  return new MarketRequestError(fallback, response.status);
}

export type Fetched<T> = { status: 304 } | { status: 200; payload: T; etag: string | null };

export async function fetchSnapshot(options: { force?: boolean; intradayRevision?: string; etag?: string } = {}): Promise<Fetched<SnapshotPayload>> {
  const query = new URLSearchParams();
  if (options.force) query.set("refresh", "1");
  if (options.intradayRevision) query.set("intraday", options.intradayRevision);
  const response = await request(`/api/market/snapshot${query.size ? `?${query}` : ""}`, options.etag ? { headers: { "If-None-Match": options.etag } } : {});
  if (response.status === 304) return { status: 304 };
  if (!response.ok) throw failure(response, "市場価格を取得できませんでした");
  const payload = parseSnapshotPayload(await response.json().catch(() => null));
  if (!payload) throw new MarketRequestError("市場価格の応答を確認できませんでした");
  return { status: 200, payload, etag: response.headers.get("ETag") };
}

/** `from` is a year start: only the earliest needed year leaves the device. */
export async function fetchHistory(from: string, etag?: string): Promise<Fetched<HistoryPayload>> {
  const response = await request(`/api/market/history?from=${from}`, etag ? { headers: { "If-None-Match": etag } } : {}, 30_000);
  if (response.status === 304) return { status: 304 };
  if (!response.ok) throw failure(response, "価格履歴を取得できませんでした");
  const payload = parseHistoryPayload(await response.json().catch(() => null));
  if (!payload) throw new MarketRequestError("価格履歴の応答を確認できませんでした");
  return { status: 200, payload, etag: response.headers.get("ETag") };
}

const catalogListeners = new Set<() => void>();

export function onMarketCatalogChange(listener: () => void) {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

/** Adds explicitly selected securities to the shared catalog (cloud: one per request). */
export async function registerMarketSecurities(securityIds: string[]) {
  const ids = [...new Set(securityIds.filter(Boolean))];
  if (!ids.length) return false;
  const response = await request("/api/market/registry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ securityIds: ids }) });
  if (!response.ok) return false;
  const result = await response.json().catch(() => null) as { added?: unknown } | null;
  if (Array.isArray(result?.added) && result.added.length) for (const listener of catalogListeners) listener();
  return true;
}

const searchCache = new Map<string, { expiresAt: number; results: unknown[] }>();

export async function searchMarketSecurities<T>(query: string, options: { signal?: AbortSignal; onNetworkRequest?: () => void } = {}): Promise<T[]> {
  const normalized = query.trim().toLocaleLowerCase("ja");
  if (!normalized) return [];
  const cached = searchCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.results as T[];
  options.onNetworkRequest?.();
  const response = await request("/api/market/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: query.trim() }),
    ...(options.signal ? { signal: options.signal } : {}),
  }, 4_000);
  if (!response.ok) throw failure(response, "銘柄を検索できませんでした");
  const payload = await response.json().catch(() => null) as { results?: unknown } | null;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(normalized, { expiresAt: Date.now() + 15 * 60_000, results });
  return results as T[];
}

// ---- Startup prefetch ---------------------------------------------------------------------------

let prefetched: { at: number; task: Promise<Fetched<SnapshotPayload>> } | null = null;

/** Starts the first snapshot request before the dashboard mounts (e.g. while the vault unlocks). */
export function prefetchMarketSnapshot(intradayRevision?: string) {
  if (prefetched && Date.now() - prefetched.at < 10_000) return;
  const task = fetchSnapshot({ intradayRevision });
  task.catch(() => undefined);
  prefetched = { at: Date.now(), task };
}

/** Returns a prefetched snapshot request started within the last 10 seconds, once. */
export function takePrefetchedSnapshot() {
  const current = prefetched;
  prefetched = null;
  return current && Date.now() - current.at < 10_000 ? current.task : null;
}

// ---- Browser cache keys ------------------------------------------------------------------------

export const MARKET_SNAPSHOT_KEY = "kabutora-market-v4-snapshot";
export const MARKET_HISTORY_KEY = "kabutora-market-v4-history";

/** Removes saved market responses (sign-out). Portfolio data is never stored under these keys. */
export function clearMarketCache() {
  try {
    for (const key of [MARKET_SNAPSHOT_KEY, MARKET_HISTORY_KEY]) window.localStorage.removeItem(key);
  } catch { /* Storage is optional. */ }
}
