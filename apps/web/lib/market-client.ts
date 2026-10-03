import type { CorporateAction, DistributionEvent, IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";
import { writeServerSnapshotCache, type PersistedServerSnapshot } from "./client-market-cache";
import { getMarketAuthHeaders } from "./firebase-client";
import { mergeIntradayBars } from "./intraday-cache";
import { MarketApiResponseError } from "./market-api-response";
import { unpackHistoryBars, type PackedHistorySeries } from "./market-history";
import { validateMarketPayload } from "./market-payload-validation";
import { portfolioMarketSessions } from "./market-session";
import { timeoutSignal } from "./operation-deadline";
import type { DistributionCoverage, ServerBenchmark, ServerMarketSnapshot, ServerRemoteQuote } from "./server-market-types";
import { isRecord } from "./validation-primitives";

/**
 * The only market transport. One GET returns quotes, benchmarks and intraday charts for
 * the shared public catalog; the browser filters its private holdings locally.
 */

type WireSeries = { id: string; v: string; s?: MarketQuote["session"]; x?: string; t: number[]; p: number[] };
type WireSnapshot = {
  full: boolean;
  generatedAt: string;
  revision: string;
  catalogKey: string;
  quotes: ServerRemoteQuote[];
  benchmarks: ServerBenchmark[];
  series: WireSeries[];
  failures: Array<{ securityId: string; message: string }>;
};

/** Re-request this many seconds before the newest point so a forming bar is updated. */
const SINCE_OVERLAP_SECONDS = 15 * 60;
/** The app shell and dashboard both ask at startup; a just-loaded snapshot is reused. */
const REUSE_MS = 10_000;
let current: { revision: string; catalogKey: string; lastTime: number; loadedAt: number; snapshot: ServerMarketSnapshot } | null = null;
let flight: Promise<ServerMarketSnapshot | null> | null = null;
let restoring: Promise<void> | null = null;
let persist = false;
let epoch = 0;
const catalogListeners = new Set<() => void>();

/** Drop session state when the signed-in account changes. */
export function resetMarketClient(options: { persist?: boolean } = {}) {
  current = null;
  flight = null;
  restoring = null;
  persist = options.persist === true;
  epoch += 1;
}

/** Seed from this device's saved snapshot so the first request is a 304 or a small delta. */
export function restoreMarketClient(saved: Promise<PersistedServerSnapshot | null>) {
  const session = epoch;
  restoring = saved.then((entry) => {
    const [revision, catalogKey, lastTime] = entry?.etag.split("|") ?? [];
    if (!entry || session !== epoch || current || !revision || !catalogKey || !(Number(lastTime) > 0)) return;
    current = { revision, catalogKey, lastTime: Number(lastTime), loadedAt: 0, snapshot: entry.snapshot };
  }).catch(() => undefined);
}

export function latestMarketSnapshot() {
  return current?.snapshot ?? null;
}

function failure(response: Response, fallback: string) {
  return new MarketApiResponseError(fallback, response.status);
}

function decodeSeries(series: WireSeries[]): IntradayBar[] {
  const bars: IntradayBar[] = [];
  for (const item of series) {
    let time = 0;
    for (let index = 0; index < Math.min(item.t.length, item.p.length); index += 1) {
      time += item.t[index];
      bars.push({
        securityId: item.id,
        timestamp: new Date(time * 1000).toISOString(),
        price: String(item.p[index]),
        provider: item.v,
        ...(item.s ? { session: item.s } : {}),
        ...(item.x ? { venueCode: item.x } : {}),
      });
    }
  }
  return bars;
}

function parseWire(value: unknown): WireSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.revision !== "string" || typeof value.catalogKey !== "string"
    || typeof value.generatedAt !== "string" || !Array.isArray(value.series) || !Array.isArray(value.failures)) {
    throw new Error("market_snapshot_invalid");
  }
  for (const item of value.series) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.v !== "string" || !Array.isArray(item.t) || !Array.isArray(item.p)
      || !item.t.every(Number.isFinite) || !item.p.every((price) => typeof price === "number" && price > 0)) {
      throw new Error("market_series_invalid");
    }
  }
  validateMarketPayload({ quotes: value.quotes, benchmarks: value.benchmarks });
  return value as unknown as WireSnapshot;
}

function toSnapshot(wire: WireSnapshot, intraday: IntradayBar[], serverTime: string, stale: boolean): ServerMarketSnapshot {
  const { quotes } = wire;
  return {
    schemaVersion: 1,
    generatedAt: serverTime,
    savedAt: wire.generatedAt,
    marketSessions: portfolioMarketSessions("ALL", new Date(serverTime)),
    quotes,
    benchmarks: wire.benchmarks,
    intraday,
    coverage: {
      registered: quotes.length + wire.failures.filter((item) => !quotes.some((quote) => quote.securityId === item.securityId)).length,
      quoted: quotes.length,
      fresh: quotes.filter((quote) => quote.freshness === "live" || quote.freshness === "near_live").length,
      stale: quotes.filter((quote) => quote.freshness === "stale").length,
      suspect: quotes.filter((quote) => quote.validationStatus === "suspect").length,
    },
    refresh: { status: !quotes.length ? "empty" : stale ? "partial" : "ready", lastRunAt: wire.generatedAt },
  };
}

async function loadSnapshot(force: boolean) {
  const session = epoch;
  if (restoring) await Promise.race([restoring, new Promise((resolve) => setTimeout(resolve, 300))]);
  const previous = current;
  const params = new URLSearchParams();
  if (force) params.set("refresh", "1");
  if (previous?.lastTime) {
    params.set("since", String(previous.lastTime - SINCE_OVERLAP_SECONDS));
    params.set("catalog", previous.catalogKey);
  }
  const query = params.toString();
  const response = await fetch(`/api/market/snapshot${query ? `?${query}` : ""}`, {
    cache: "no-store",
    headers: { ...await getMarketAuthHeaders(), ...(previous ? { "If-None-Match": `"${previous.revision}"` } : {}) },
    signal: timeoutSignal(12_000),
  });
  if (session !== epoch) return null;
  const serverTime = response.headers.get("X-Market-Server-Time") ?? new Date().toISOString();
  if (response.status === 304 && previous) {
    // Unchanged prices were re-verified upstream at X-Market-Generated-At.
    const verifiedAt = response.headers.get("X-Market-Generated-At") ?? serverTime;
    previous.snapshot = {
      ...previous.snapshot,
      generatedAt: serverTime,
      marketSessions: portfolioMarketSessions("ALL", new Date(serverTime)),
      quotes: previous.snapshot.quotes.map((quote) => quote.fetchedAt < verifiedAt ? { ...quote, fetchedAt: verifiedAt } : quote),
    };
    previous.loadedAt = Date.now();
    return previous.snapshot;
  }
  if (!response.ok) throw failure(response, "市場価格を取得できませんでした");
  const wire = parseWire(await response.json());
  const incoming = decodeSeries(wire.series);
  const intraday = wire.full || !previous ? mergeIntradayBars([], incoming) : mergeIntradayBars(previous.snapshot.intraday, incoming);
  const lastTime = Math.max(previous?.lastTime ?? 0, ...wire.series.map((item) => item.t.reduce((sum, delta) => sum + delta, 0)));
  const snapshot = toSnapshot(wire, intraday, serverTime, response.headers.get("X-Market-Stale") === "1");
  current = { revision: wire.revision, catalogKey: wire.catalogKey, lastTime, loadedAt: Date.now(), snapshot };
  if (persist) void writeServerSnapshotCache("full", snapshot, `${wire.revision}|${wire.catalogKey}|${lastTime}`);
  return snapshot;
}

/** Concurrent callers (app shell, dashboard, timers) share one request. */
export function fetchMarketSnapshot(options: { force?: boolean } = {}) {
  if (!options.force && current && Date.now() - current.loadedAt < REUSE_MS) return Promise.resolve(current.snapshot);
  if (flight && !options.force) return flight;
  const task = loadSnapshot(options.force === true).finally(() => { if (flight === task) flight = null; });
  flight = task;
  return task;
}

export type MarketHistoryResult = {
  generatedAt: string;
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  inceptionDates: Record<string, string>;
  pending: string[];
};

/** Catalog-wide daily closes from the start of `from`'s year. */
export async function fetchMarketHistory(from: string): Promise<MarketHistoryResult> {
  const response = await fetch(`/api/market/history?from=${encodeURIComponent(`${from.slice(0, 4)}-01-01`)}`, {
    cache: "no-store",
    headers: await getMarketAuthHeaders(),
    signal: timeoutSignal(60_000),
  });
  if (!response.ok) throw failure(response, "履歴を取得できませんでした");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.series) || !Array.isArray(payload.corporateActions) || !isRecord(payload.inceptionDates) || !Array.isArray(payload.pending)) {
    throw failure(response, "履歴を取得できませんでした");
  }
  for (const item of Object.values(payload.series)) {
    if (!isRecord(item) || typeof item.provider !== "string" || !Array.isArray(item.rows)) throw failure(response, "履歴を取得できませんでした");
  }
  const bars = unpackHistoryBars(payload.series as PackedHistorySeries);
  validateMarketPayload({ bars, corporateActions: payload.corporateActions });
  return {
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString(),
    bars,
    corporateActions: payload.corporateActions as CorporateAction[],
    inceptionDates: Object.fromEntries(Object.entries(payload.inceptionDates).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    pending: payload.pending.filter((id): id is string => typeof id === "string"),
  };
}

export type MarketDistributionResult = {
  generatedAt: string;
  distributions: DistributionEvent[];
  corporateActions: CorporateAction[];
  coverage: DistributionCoverage[];
};

export async function fetchMarketDistributions(): Promise<MarketDistributionResult> {
  const response = await fetch("/api/market/distributions", { cache: "no-store", headers: await getMarketAuthHeaders(), signal: timeoutSignal(60_000) });
  if (!response.ok) throw failure(response, "配当データを取得できませんでした");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.coverage)) throw failure(response, "配当データを取得できませんでした");
  validateMarketPayload({ distributions: payload.distributions, corporateActions: payload.corporateActions });
  return {
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString(),
    distributions: (payload.distributions ?? []) as DistributionEvent[],
    corporateActions: (payload.corporateActions ?? []) as CorporateAction[],
    coverage: payload.coverage.filter((item): item is DistributionCoverage => isRecord(item) && typeof item.securityId === "string" && typeof item.status === "string"),
  };
}

/**
 * Adds public securities to the shared catalog. Cloud clients call this only for an
 * explicit search selection (one id); the local Mac app may register its whole list.
 */
export async function registerMarketSecurities(securityIds: string[], options: { notify?: boolean } = {}) {
  if (!securityIds.length) return false;
  const response = await fetch("/api/market/registry", {
    method: "POST",
    cache: "no-store",
    headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ securityIds }),
    signal: timeoutSignal(8_000),
  });
  if (!response.ok) return false;
  const payload: unknown = await response.json().catch(() => null);
  if (options.notify !== false && isRecord(payload) && Array.isArray(payload.added) && payload.added.length) {
    for (const listener of catalogListeners) listener();
  }
  return true;
}

export function onMarketCatalogChange(listener: () => void) {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}
