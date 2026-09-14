import { getMarketAuthHeaders } from "./firebase-client";
import { readMarketApiResponse } from "./market-api-response";
import { readServerSnapshotCache, writeServerSnapshotCache } from "./client-market-cache";
import type { ServerMarketSnapshot } from "./server-market-types";
import type { IntradayBar } from "@kabutora/domain";
import { timeoutSignal } from "./operation-deadline";

const snapshotEtags = { full: "", compact: "" };
const usIntradayEtags = new Map<string, string>();
const cachedSnapshots: { full: ServerMarketSnapshot | null; compact: ServerMarketSnapshot | null } = { full: null, compact: null };

export function clearInMemorySnapshotCache() {
  snapshotEtags.full = "";
  snapshotEtags.compact = "";
  cachedSnapshots.full = null;
  cachedSnapshots.compact = null;
  usIntradayEtags.clear();
}

export function getCachedServerMarketSnapshot(mode: "full" | "compact" = "compact"): ServerMarketSnapshot | null {
  return cachedSnapshots[mode];
}

export async function loadServerMarketSnapshot(options: {
  timeoutMs?: number;
  includeIntraday?: boolean;
  allowPersistentCache?: boolean;
} = {}) {
  const mode = options.includeIntraday === true ? "full" : "compact";
  const allowPersistentCache = options.allowPersistentCache !== false;

  if (allowPersistentCache && (!snapshotEtags[mode] || !cachedSnapshots[mode])) {
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
  const response = await fetch(`/api/market/intraday?${params}`, {
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
  const response = await fetch(`/api/market/intraday?${params}`, {
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
    body: JSON.stringify({ securityIds: unique }),
    signal: timeoutSignal(8_000),
  });
  const payload = await readMarketApiResponse<{ runId?: string; accepted?: number; queued?: number; budgetLimited?: boolean; error?: string }>(response, "市場データの更新依頼を確認できませんでした");
  if (!response.ok && response.status !== 429) throw new Error(payload.error ?? "market_refresh_failed");
  return payload;
}

export async function syncServerMarketRegistry(securityIds: string[], mode: "merge" | "reconcile" = "merge") {
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
