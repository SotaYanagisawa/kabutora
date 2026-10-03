import { portfolioMarketSessions } from "./market-session";
import { clearPublicMarketCache, fetchMarketResponse, usesPublicMarketBackend, loadPublicMarketResource } from "./public-market-client";
import { getMarketAuthHeaders } from "./firebase-client";
import { readMarketApiResponse } from "./market-api-response";
import { readServerSnapshotCache, writeServerSnapshotCache } from "./client-market-cache";
import type { ServerMarketSnapshot } from "./server-market-types";
import type { IntradayBar } from "@kabutora/domain";
import { timeoutSignal } from "./operation-deadline";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import { mergeQuoteRecords, mergeBenchmarks } from "./market-snapshot-merge";
import { mergeIntradayBars } from "./intraday-cache";

const snapshotEtags = { full: "", compact: "" };
const usIntradayEtags = new Map<string, string>();
const cachedSnapshots: { full: ServerMarketSnapshot | null; compact: ServerMarketSnapshot | null } = { full: null, compact: null };

export function clearInMemorySnapshotCache() {
  snapshotEtags.full = "";
  snapshotEtags.compact = "";
  cachedSnapshots.full = null;
  cachedSnapshots.compact = null;
  usIntradayEtags.clear();
  clearPublicMarketCache();
}

export function getCachedServerMarketSnapshot(mode: "full" | "compact" = "compact"): ServerMarketSnapshot | null {
  return cachedSnapshots[mode];
}

/** Paint saved charts immediately; neither storage nor charts block fresh prices. */
export async function loadStartupMarketSnapshots(options: {
  allowPersistentCache: boolean;
  onSnapshot: (snapshot: ServerMarketSnapshot) => void;
}) {
  let saved: ServerMarketSnapshot | null = null;
  const merge = (previous: ServerMarketSnapshot | null, snapshot: ServerMarketSnapshot): ServerMarketSnapshot => previous ? {
    ...snapshot,
    quotes: Object.values(mergeQuoteRecords(
      Object.fromEntries(previous.quotes.map((quote) => [quote.securityId, quote])),
      Object.fromEntries(snapshot.quotes.map((quote) => [quote.securityId, quote])),
    )),
    benchmarks: mergeBenchmarks(previous.benchmarks, snapshot.benchmarks),
    intraday: mergeIntradayBars(previous.intraday, snapshot.intraday),
  } : snapshot;
  const restore = options.allowPersistentCache
    ? readServerSnapshotCache("full").then(async (full) => full ?? await readServerSnapshotCache("compact"))
      .then((entry) => {
        if (entry?.snapshot) {
          // A slower storage read can still supply charts after fresh prices arrive.
          // Saved data carries no live clock/session authority.
          const cached: ServerMarketSnapshot = {
            ...entry.snapshot,
            generatedAt: "",
            marketSessions: [],
            refresh: { ...entry.snapshot.refresh, status: "partial" },
          };
          saved = merge(cached, saved ?? cached);
          options.onSnapshot(saved);
        }
      })
    : Promise.resolve();
  const publish = (snapshot: ServerMarketSnapshot | null) => {
    if (!snapshot) return;
    saved = merge(saved, snapshot);
    options.onSnapshot(saved);
  };
  await Promise.allSettled([
    restore,
    loadServerMarketSnapshot({ allowPersistentCache: options.allowPersistentCache, restorePersistentCache: false }).then(publish),
    loadServerMarketSnapshot({ includeIntraday: true, allowPersistentCache: options.allowPersistentCache, restorePersistentCache: false }).then(publish),
  ]);
}

export async function loadServerMarketSnapshot(options: {
  timeoutMs?: number;
  includeIntraday?: boolean;
  allowPersistentCache?: boolean;
  restorePersistentCache?: boolean;
} = {}) {
  const mode = options.includeIntraday === true ? "full" : "compact";
  if (usesPublicMarketBackend()) {
    try {
      const [payload, points] = await Promise.all([
        loadPublicMarketResource("quotes"),
        options.includeIntraday ? loadPublicMarketResource("intraday") : Promise.resolve(undefined),
      ]);
      const quotes=Array.isArray(payload.quotes) ? payload.quotes as ServerMarketSnapshot["quotes"] : [];
      const benchmarks=Array.isArray(payload.benchmarks) ? payload.benchmarks as ServerMarketSnapshot["benchmarks"] : [];
      const fresh=quotes.filter((quote)=>Date.now()-Date.parse(quote.fetchedAt)<20*60_000).length;
      const snapshot:ServerMarketSnapshot={schemaVersion:1,generatedAt:String(payload.generatedAt ?? new Date().toISOString()),savedAt:quotes.map((quote)=>quote.fetchedAt).sort().at(-1) ?? null,marketSessions:portfolioMarketSessions("ALL"),quotes,benchmarks,intraday:Array.isArray(points?.bars) ? points.bars as IntradayBar[] : [],coverage:{registered:quotes.length,quoted:quotes.length,fresh,stale:quotes.length-fresh,suspect:quotes.filter((quote)=>quote.validationStatus==="suspect").length},refresh:{status:quotes.length ? "ready" : "empty",lastRunAt:null,queueMessagesToday:0,providerCallsToday:0}};
      cachedSnapshots[mode]=snapshot;
      if(options.allowPersistentCache!==false) void writeServerSnapshotCache(mode,snapshot,`v2-${snapshot.savedAt}`).catch(()=>undefined);
      return snapshot;
    } catch {
      if(cachedSnapshots[mode]) return cachedSnapshots[mode];
      if(options.allowPersistentCache!==false) return (await readServerSnapshotCache(mode).catch(()=>null))?.snapshot ?? null;
      return null;
    }
  }

  const allowPersistentCache = options.allowPersistentCache !== false;

  if (allowPersistentCache && options.restorePersistentCache !== false && (!snapshotEtags[mode] || !cachedSnapshots[mode])) {
    try {
      const persisted = await readServerSnapshotCache(mode);
      if (persisted?.etag && persisted?.snapshot) {
        snapshotEtags[mode] = persisted.etag;
        cachedSnapshots[mode] = persisted.snapshot;
      }
    } catch {
      // Best-effort IndexedDB recovery
    }
  }

  const authHeaders = await getMarketAuthHeaders();
  const headers: Record<string, string> = { ...authHeaders };
  if (snapshotEtags[mode]) {
    headers["If-None-Match"] = snapshotEtags[mode];
  }

  const response = await fetch(`/api/market/snapshot${mode === "compact" ? "?intraday=0" : ""}`, {
    cache: "no-store",
    headers,
    signal: timeoutSignal(options.timeoutMs ?? 4_000),
  });
  if (response.status === 304) {
    if (!cachedSnapshots[mode] && allowPersistentCache) {
      const persisted = await readServerSnapshotCache(mode);
      if (persisted) cachedSnapshots[mode] = persisted.snapshot;
    }
    const clock=response.headers.get("X-Market-Server-Time");
    if (cachedSnapshots[mode] && clock) cachedSnapshots[mode]={...cachedSnapshots[mode]!,generatedAt:clock};
    return cachedSnapshots[mode];
  }
  if (response.status === 204 || response.status === 503) return cachedSnapshots[mode];
  const snapshot = await readMarketApiResponse<ServerMarketSnapshot>(response, "サーバーの市場スナップショットを確認できませんでした");
  if (!response.ok || snapshot.schemaVersion !== 1) return null;
  const etag = response.headers.get("ETag") ?? "";
  snapshotEtags[mode] = etag;
  cachedSnapshots[mode] = snapshot;
  if (allowPersistentCache && etag) {
    void writeServerSnapshotCache(mode, snapshot, etag);
  }
  return snapshot;
}

export async function loadServerPtsIntraday(securityIds: string[], cursor?: string | null) {
  const unique = [...new Set(securityIds.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  if (!unique.length) return { bars: [] as IntradayBar[], nextCursor: cursor ?? null, generatedAt: new Date().toISOString() };
  const params = new URLSearchParams({ securityIds: unique.join(",") });
  if (cursor) params.set("cursor", cursor);
  const response = await fetchMarketResponse(`/api/market/intraday?${params}`, {
    cache: "no-store",
    headers: await getMarketAuthHeaders(),
    signal: timeoutSignal(4_000),
  });
  const payload = await readMarketApiResponse<{ bars?: IntradayBar[]; nextCursor?: string | null; generatedAt?: string }>(response, "PTS価格を確認できませんでした");
  if (!response.ok) throw new Error("market_pts_intraday_failed");
  return {
    bars: Array.isArray(payload.bars) ? payload.bars : [],
    nextCursor: payload.nextCursor ?? cursor ?? null,
    generatedAt: payload.generatedAt ?? new Date().toISOString(),
  };
}

export type ServerUsIntradayResult = {
  bars: IntradayBar[];
  revision: string | null;
  generatedAt: string;
  sessions: Array<{
    securityId: string;
    currentSessionDate: string;
    currentPoints: number;
    previousSessionDate: string | null;
    previousPoints: number;
    ready: boolean;
  }>;
  coverage: { requested: number; ready: number; currentReady: number };
};

export async function loadServerUsIntraday(securityIds: string[], options: { recover?: boolean } = {}): Promise<ServerUsIntradayResult | null> {
  const unique = [...new Set(securityIds.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  if (!unique.length) return null;
  const key = [...unique].sort().join(",");
  const params = new URLSearchParams({ market: "US", securityIds: unique.join(",") });
  if (options.recover) params.set("recover", "1");
  const headers: Record<string, string> = { ...await getMarketAuthHeaders() };
  const etag = usIntradayEtags.get(key);
  if (etag && !options.recover) headers["If-None-Match"] = etag;
  const response = await fetchMarketResponse(`/api/market/intraday?${params}`, {
    cache: "no-store",
    headers,
    signal: timeoutSignal(options.recover ? 45_000 : 6_000),
  });
  if (response.status === 304) return null;
  const payload = await readMarketApiResponse<Partial<ServerUsIntradayResult>>(response, "米国株チャートを確認できませんでした");
  if (!response.ok) throw new Error("market_us_intraday_failed");
  const nextEtag = response.headers.get("ETag");
  if (nextEtag) usIntradayEtags.set(key, nextEtag);
  return {
    bars: Array.isArray(payload.bars) ? payload.bars : [],
    revision: typeof payload.revision === "string" ? payload.revision : null,
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString(),
    sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
    coverage: payload.coverage ?? { requested: unique.length, ready: 0, currentReady: 0 },
  };
}

export async function requestServerMarketRefresh(securityIds: string[]) {
  const unique = [...new Set(securityIds.map((value) => value.trim()).filter(Boolean))].slice(0, 200);
  if (!unique.length) return null;
  const response = await fetch("/api/market/refresh", {
    method: "POST",
    cache: "no-store",
    headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(usesPublicMarketBackend() ? {} : { securityIds: unique }),
    signal: timeoutSignal(8_000),
  });
  const payload = await readMarketApiResponse<{ runId?: string; accepted?: number; queued?: number; budgetLimited?: boolean; error?: string }>(response, "市場データの更新依頼を確認できませんでした");
  if (!response.ok && response.status !== 429) throw new Error(payload.error ?? "market_refresh_failed");
  return payload;
}

/** Provider work belongs in the queue; foreground requests only read snapshots. */
export async function refreshQueuedMarketData(securityIds: string[], options: {
  allowPersistentCache: boolean;
  onSnapshot: (snapshot: ServerMarketSnapshot) => unknown;
}) {
  const startedAt = Date.now();
  const requested = new Set(securityIds.map(canonicalDomainSecurityId));
  const result = await requestServerMarketRefresh(securityIds);
  if (!result) return "empty" as const;
  if (usesPublicMarketBackend() && result.runId) {
    const deadline = Date.now() + 30_000;
    do {
      if (typeof document !== "undefined" && document.hidden) return "pending" as const;
      const response = await fetch(`/api/market/progress?runId=${encodeURIComponent(result.runId)}`, {cache:"no-store",headers:await getMarketAuthHeaders(),signal:timeoutSignal(5000)});
      if (response.ok) {
        const progress: unknown = await response.json();
        if (progress && typeof progress === "object" && "status" in progress) {
          if ("budgetDeferred" in progress && typeof progress.budgetDeferred === "number" && progress.budgetDeferred > 0) return "limited" as const;
          if (progress.status === "complete" || progress.status === "partial") {
            clearPublicMarketCache();
            const snapshot = await loadServerMarketSnapshot({allowPersistentCache:options.allowPersistentCache});
            if (snapshot) options.onSnapshot(snapshot);
            return progress.status === "complete" ? "updated" as const : "partial" as const;
          }
          if (progress.status === "unknown" && result.budgetLimited) return "limited" as const;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 250));
    } while (Date.now() < deadline);
    return "pending" as const;
  }
  const deadline = Date.now() + 30_000;
  do {
    const snapshot = await loadServerMarketSnapshot({ allowPersistentCache: options.allowPersistentCache });
    if (snapshot) {
      options.onSnapshot(snapshot);
      if (!result.queued) return result.budgetLimited ? "limited" as const : "cached" as const;
      const refreshed = new Set(snapshot.quotes.filter((quote) => Date.parse(quote.fetchedAt) >= startedAt)
        .map((quote) => canonicalDomainSecurityId(quote.securityId)));
      if ([...requested].every((id) => refreshed.has(id))) return "updated" as const;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  return "pending" as const;
}

export async function syncServerMarketRegistry(securityIds: string[], mode: "merge" | "reconcile" = "merge") {
  if (usesPublicMarketBackend()) return true;
  const unique = [...new Set(securityIds.map((value) => value.trim()).filter(Boolean))].slice(0, 250);
  if (!unique.length) return false;
  const response = await fetch("/api/market/registry", {
    method: "POST",
    cache: "no-store",
    headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ securityIds: unique, mode }),
    signal: timeoutSignal(15_000),
  });
  return response.ok;
}
