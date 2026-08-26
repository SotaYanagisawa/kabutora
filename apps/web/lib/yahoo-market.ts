import type { CorporateAction, IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";

type YahooChartResult = {
  meta?: {
    currency?: string;
    symbol?: string;
    shortName?: string;
    longName?: string;
    exchangeName?: string;
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    regularMarketTime?: number;
    regularMarketOpen?: number;
    regularMarketDayHigh?: number;
    regularMarketDayLow?: number;
    regularMarketVolume?: number;
    firstTradeDate?: number;
    currentTradingPeriod?: {
      pre?: { start?: number; end?: number };
      regular?: { start?: number; end?: number };
      post?: { start?: number; end?: number };
    };
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
    adjclose?: Array<{ adjclose?: Array<number | null> }>;
  };
  events?: {
    splits?: Record<string, { date?: number; numerator?: number; denominator?: number; splitRatio?: string }>;
  };
};

type YahooPayload = {
  chart?: { result?: YahooChartResult[] | null; error?: { code?: string; description?: string } | null };
};

type YahooJapanBoard = {
  codeWithMarketExtension?: string;
  label?: string;
  price?: { value?: string };
  priceChange?: { value?: string };
  japanUpdateTime?: string;
  delayMinutes?: number;
  ptsPrice?: string;
  ptsUpdateTime?: string;
};

type CacheEntry<T> = { value: T; expiresAt: number; staleUntil: number };
type ProviderResult<T> = { value: T; cacheState: "network" | "edge" | "memory" | "stale"; host: string };
type EdgeCacheEntry = CacheEntry<YahooChartResult>;

const responseCache = new Map<string, CacheEntry<YahooChartResult>>();
const japanBoardCache = new Map<string, CacheEntry<YahooJapanBoard>>();
const inFlight = new Map<string, Promise<ProviderResult<YahooChartResult>>>();
const hostCooldown = new Map<string, number>();
const providerWaiters: Array<() => void> = [];
let activeProviderRequests = 0;
const MAX_PROVIDER_CONCURRENCY = 3;
const MAX_MEMORY_CACHE_ENTRIES = 600;
const ACTIVE_QUOTE_TTL_MS = 9 * 60 * 1000;
const CLOSED_QUOTE_TTL_MS = 6 * 60 * 60 * 1000;
const hosts = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const USER_AGENT = "Kabutora/1.0 personal-portfolio-tracker";

async function withProviderSlot<T>(task: () => Promise<T>) {
  if (activeProviderRequests >= MAX_PROVIDER_CONCURRENCY) await new Promise<void>((resolve) => providerWaiters.push(resolve));
  activeProviderRequests += 1;
  try {
    return await task();
  } finally {
    activeProviderRequests -= 1;
    providerWaiters.shift()?.();
  }
}

export class MarketDataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MarketDataError";
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToIso(value: number) {
  return new Date(value * 1000).toISOString();
}

function ymdInTokyo(value: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value * 1000));
}

function queryString(params: Record<string, string>) {
  const query = new URLSearchParams({ ...params, includePrePost: "true" });
  return query.toString();
}

function chartUrl(host: string, symbol: string, params: Record<string, string>) {
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${queryString(params)}`;
}

function edgeChartUrl(symbol: string, params: Record<string, string>) {
  if (params.interval !== "1d") return chartUrl(hosts[0], symbol, params);
  const canonical = { ...params, period1: "full-history", period2: "rolling", cacheSchema: "2" };
  return chartUrl(hosts[0], symbol, canonical);
}

function historyCoverageIncludes(result: YahooChartResult, params: Record<string, string>) {
  if (params.interval !== "1d") return true;
  const timestamps = (result.timestamp ?? []).filter(Number.isFinite);
  if (!timestamps.length) return false;
  const requestedStart = Number(params.period1);
  const requestedEnd = Number(params.period2);
  const first = timestamps[0];
  const last = timestamps.at(-1)!;
  const firstTrade = finiteNumber(result.meta?.firstTradeDate);
  const startCovered = !Number.isFinite(requestedStart)
    || first <= requestedStart + 7 * 24 * 60 * 60
    || (firstTrade != null && requestedStart < firstTrade && first <= firstTrade + 7 * 24 * 60 * 60);
  return startCovered
    && (!Number.isFinite(requestedEnd) || last >= Math.min(requestedEnd, Date.now() / 1000) - 7 * 24 * 60 * 60);
}

function sliceHistoryResult(result: YahooChartResult, params: Record<string, string>) {
  if (params.interval !== "1d") return result;
  const start = Number(params.period1);
  const end = Number(params.period2);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const indexes = timestamps.flatMap((timestamp, index) => (
    (!Number.isFinite(start) || timestamp >= start) && (!Number.isFinite(end) || timestamp <= end) ? [index] : []
  ));
  const splits = Object.fromEntries(Object.entries(result.events?.splits ?? {}).filter(([key, split]) => {
    const timestamp = finiteNumber(split.date) ?? finiteNumber(Number(key));
    return timestamp != null && (!Number.isFinite(start) || timestamp >= start) && (!Number.isFinite(end) || timestamp <= end);
  }));
  return {
    ...result,
    timestamp: indexes.map((index) => timestamps[index]),
    indicators: {
      ...result.indicators,
      quote: [{ ...(result.indicators?.quote?.[0] ?? {}), close: indexes.map((index) => closes[index] ?? null) }],
      adjclose: [{ ...(result.indicators?.adjclose?.[0] ?? {}), adjclose: indexes.map((index) => adjusted[index] ?? null) }],
    },
    events: { ...result.events, splits },
  };
}

function mergeHistoryResults(existing: YahooChartResult | null, incoming: YahooChartResult, params: Record<string, string>) {
  if (params.interval !== "1d" || !existing) return incoming;
  const rows = new Map<number, { close: number | null; adjusted: number | null }>();
  const add = (result: YahooChartResult) => {
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    for (let index = 0; index < timestamps.length; index += 1) {
      rows.set(timestamps[index], { close: closes[index] ?? null, adjusted: adjusted[index] ?? null });
    }
  };
  add(existing);
  add(incoming);
  const timestamps = [...rows.keys()].sort((a, b) => a - b);
  return {
    ...existing,
    ...incoming,
    timestamp: timestamps,
    indicators: {
      ...existing.indicators,
      ...incoming.indicators,
      quote: [{ ...(incoming.indicators?.quote?.[0] ?? {}), close: timestamps.map((timestamp) => rows.get(timestamp)!.close) }],
      adjclose: [{ ...(incoming.indicators?.adjclose?.[0] ?? {}), adjclose: timestamps.map((timestamp) => rows.get(timestamp)!.adjusted) }],
    },
    events: {
      ...existing.events,
      ...incoming.events,
      splits: { ...(existing.events?.splits ?? {}), ...(incoming.events?.splits ?? {}) },
    },
  };
}

function cacheRetentionMs(params: Record<string, string>) {
  return (params.interval === "1d" ? 180 : 7) * 24 * 60 * 60 * 1000;
}

function rememberResponse(key: string, value: YahooChartResult, ttlMs: number, params: Record<string, string>, staleUntil = Date.now() + cacheRetentionMs(params)) {
  responseCache.delete(key);
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    staleUntil,
  });
  while (responseCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

async function readEdgeChart(symbol: string, params: Record<string, string>): Promise<EdgeCacheEntry | null> {
  const edgeCache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
  if (!edgeCache) return null;
  const cachedResponse = await edgeCache.match(edgeChartUrl(symbol, params));
  if (!cachedResponse) return null;
  const payload = (await cachedResponse.json()) as YahooPayload;
  const value = payload.chart?.result?.[0];
  const freshUntil = Number(cachedResponse.headers.get("X-Kabutora-Fresh-Until"));
  const staleUntil = Number(cachedResponse.headers.get("X-Kabutora-Stale-Until"));
  if (!value || !Number.isFinite(staleUntil) || staleUntil <= Date.now()) return null;
  return { value, expiresAt: Number.isFinite(freshUntil) ? freshUntil : 0, staleUntil };
}

async function writeEdgeChart(symbol: string, params: Record<string, string>, value: YahooChartResult, ttlMs: number) {
  const edgeCache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
  if (!edgeCache) return;
  const now = Date.now();
  const staleUntil = now + cacheRetentionMs(params);
  const payload: YahooPayload = { chart: { result: [value], error: null } };
  const cacheResponse = new Response(JSON.stringify(payload), {
    headers: {
      "Cache-Control": `public, max-age=${Math.floor(cacheRetentionMs(params) / 1000)}`,
      "Content-Type": "application/json",
      "X-Kabutora-Fresh-Until": String(now + ttlMs),
      "X-Kabutora-Stale-Until": String(staleUntil),
    },
  });
  await edgeCache.put(edgeChartUrl(symbol, params), cacheResponse);
}

async function requestHost(host: string, symbol: string, params: Record<string, string>) {
  const url = chartUrl(host, symbol, params);
  const response = await withProviderSlot(() => fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(12_000),
  }));
  if (!response.ok) throw new MarketDataError(`${host} returned HTTP ${response.status}`, response.status);
  const payload = (await response.json()) as YahooPayload;
  const result = payload.chart?.result?.[0];
  if (!result) {
    const detail = payload.chart?.error?.description ?? "empty chart response";
    throw new MarketDataError(`${host}: ${detail}`);
  }
  return result;
}

function orderedHosts(symbol: string) {
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) hash = (Math.imul(hash, 31) + symbol.charCodeAt(index)) | 0;
  return Math.abs(hash) % hosts.length === 0 ? hosts : [...hosts].reverse();
}

function extractJsonObject(value: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}

export function parseYahooJapanQuotePage(html: string): YahooJapanBoard | null {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)<\/script>/gu)]
    .flatMap((match) => {
      try { return [JSON.parse(match[1]) as string]; } catch { return []; }
    })
    .join("");
  const priceBoard = chunks.indexOf('"priceBoard"');
  const boardKey = priceBoard < 0 ? -1 : chunks.indexOf('"board":', priceBoard);
  const objectStart = boardKey < 0 ? -1 : chunks.indexOf("{", boardKey);
  const serialized = objectStart < 0 ? null : extractJsonObject(chunks, objectStart);
  if (!serialized) return null;
  try {
    const board = JSON.parse(serialized) as YahooJapanBoard;
    const priceBoardChunk = chunks.slice(priceBoard, priceBoard + 20_000);
    const ptsPrice = /"ptsPrice":"([^"]+)"/u.exec(priceBoardChunk)?.[1];
    const ptsUpdateTime = /"ptsUpdateTime":"([^"]+)"/u.exec(priceBoardChunk)?.[1];
    return board.codeWithMarketExtension && board.price?.value ? { ...board, ptsPrice, ptsUpdateTime } : null;
  } catch {
    return null;
  }
}

function tokyoPtsTimestamp(value: string | undefined) {
  const match = /^(?:(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})$/u.exec(value ?? "");
  if (!match) return null;
  const now = new Date(Date.now() + 9 * 60 * 60_000);
  const currentMonth = now.getUTCMonth() + 1;
  const month = Number(match[1] ?? currentMonth);
  const day = Number(match[2] ?? now.getUTCDate());
  let year = now.getUTCFullYear();
  if (currentMonth === 1 && month === 12) year -= 1;
  else if (currentMonth === 12 && month === 1) year += 1;
  const timestamp = Date.UTC(year, month - 1, day, Number(match[3]) - 9, Number(match[4]));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function japanBoardEdgeUrl(symbol: string) {
  return `https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}?kabutora-pts-cache=v2`;
}

async function readEdgeJapanBoard(symbol: string): Promise<CacheEntry<YahooJapanBoard> | null> {
  const edgeCache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
  if (!edgeCache) return null;
  const response = await edgeCache.match(japanBoardEdgeUrl(symbol));
  if (!response) return null;
  const value = await response.json() as YahooJapanBoard;
  const expiresAt = Number(response.headers.get("X-Kabutora-Fresh-Until"));
  const staleUntil = Number(response.headers.get("X-Kabutora-Stale-Until"));
  return value?.codeWithMarketExtension && Number.isFinite(staleUntil) ? { value, expiresAt, staleUntil } : null;
}

async function writeEdgeJapanBoard(symbol: string, value: YahooJapanBoard) {
  const edgeCache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
  if (!edgeCache) return;
  const now = Date.now();
  await edgeCache.put(japanBoardEdgeUrl(symbol), new Response(JSON.stringify(value), {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "application/json",
      "X-Kabutora-Fresh-Until": String(now + ACTIVE_QUOTE_TTL_MS),
      "X-Kabutora-Stale-Until": String(now + 24 * 60 * 60 * 1000),
    },
  }));
}

async function getYahooJapanBoard(symbol: string, force: boolean) {
  const cached = japanBoardCache.get(symbol);
  if (!force && cached && cached.expiresAt > Date.now()) return { board: cached.value, cacheState: "memory" as const };
  const edge = await readEdgeJapanBoard(symbol).catch(() => null);
  if (!force && edge && edge.expiresAt > Date.now()) {
    japanBoardCache.set(symbol, edge);
    return { board: edge.value, cacheState: "edge" as const };
  }
  try {
    const response = await withProviderSlot(() => fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
      signal: AbortSignal.timeout(12_000),
    }));
    if (!response.ok) throw new MarketDataError(`finance.yahoo.co.jp returned HTTP ${response.status}`, response.status);
    const board = parseYahooJapanQuotePage(await response.text());
    if (!board || board.codeWithMarketExtension !== symbol) throw new MarketDataError(`${symbol}: Yahoo Japan price board unavailable`);
    const entry = { value: board, expiresAt: Date.now() + ACTIVE_QUOTE_TTL_MS, staleUntil: Date.now() + 24 * 60 * 60 * 1000 };
    japanBoardCache.set(symbol, entry);
    await writeEdgeJapanBoard(symbol, board).catch(() => undefined);
    return { board, cacheState: "network" as const };
  } catch (error) {
    const fallback = cached && cached.staleUntil > Date.now() ? cached : edge && edge.staleUntil > Date.now() ? edge : null;
    if (fallback) return { board: fallback.value, cacheState: "stale" as const };
    throw error;
  }
}

function numericText(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", "").replace(/[+\s]/gu, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function tokyoMarketTimestamp(updateTime: string | undefined) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return updateTime && /^\d{1,2}:\d{2}$/u.test(updateTime)
    ? new Date(`${date}T${updateTime.padStart(5, "0")}:00+09:00`).toISOString()
    : new Date().toISOString();
}

function tseSessionNow(): MarketQuote["session"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  if (["Sat", "Sun"].includes(part("weekday"))) return "closed";
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return (minute >= 9 * 60 && minute <= 11 * 60 + 30) || (minute >= 12 * 60 + 30 && minute <= 15 * 60 + 30) ? "regular" : "closed";
}

async function fetchChart(
  symbol: string,
  params: Record<string, string>,
  ttlMs: number,
  force = false,
): Promise<ProviderResult<YahooChartResult>> {
  if (!/^[A-Za-z0-9.^=_-]{1,32}$/.test(symbol)) throw new MarketDataError("Invalid market symbol");
  const key = `${symbol}?${queryString(params)}`;
  const now = Date.now();
  const cached = responseCache.get(key);
  if (!force && cached && cached.expiresAt > now) return { value: cached.value, cacheState: "memory", host: "cache" };
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const failures: string[] = [];
    const edgeCached = await readEdgeChart(symbol, params).catch(() => null);
    if (!force && edgeCached && edgeCached.expiresAt > Date.now() && historyCoverageIncludes(edgeCached.value, params)) {
      const value = sliceHistoryResult(edgeCached.value, params);
      rememberResponse(key, value, Math.max(1, edgeCached.expiresAt - Date.now()), params, edgeCached.staleUntil);
      return { value, cacheState: "edge" as const, host: "edge" };
    }

    for (const host of orderedHosts(symbol)) {
      if ((hostCooldown.get(host) ?? 0) > Date.now()) continue;
      try {
        const value = await requestHost(host, symbol, params);
        rememberResponse(key, value, ttlMs, params);
        const edgeValue = mergeHistoryResults(edgeCached?.value ?? null, value, params);
        await writeEdgeChart(symbol, params, edgeValue, ttlMs).catch(() => undefined);
        return { value, cacheState: "network" as const, host };
      } catch (error) {
        const status = error instanceof MarketDataError ? error.status : undefined;
        if (status === 429) hostCooldown.set(host, Date.now() + 60 * 1000);
        if (status === 401 || status === 403) hostCooldown.set(host, Date.now() + 10 * 60 * 1000);
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cached && cached.staleUntil > Date.now()) return { value: cached.value, cacheState: "stale" as const, host: "cache" };
    if (edgeCached && edgeCached.staleUntil > Date.now()) {
      const value = sliceHistoryResult(edgeCached.value, params);
      rememberResponse(key, value, 0, params, edgeCached.staleUntil);
      return { value, cacheState: "stale" as const, host: "edge" };
    }
    throw new MarketDataError(failures.join("; ") || "Market-data providers are cooling down");
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

function latestClose(result: YahooChartResult) {
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let index = Math.min(timestamps.length, closes.length) - 1; index >= 0; index -= 1) {
    const price = finiteNumber(closes[index]);
    const timestamp = finiteNumber(timestamps[index]);
    if (price != null && price > 0 && timestamp != null) return { price, timestamp };
  }
  return null;
}

function sessionAt(nowSeconds: number, result: YahooChartResult): MarketQuote["session"] {
  const periods = result.meta?.currentTradingPeriod;
  if (periods?.pre?.start && periods.pre.end && nowSeconds >= periods.pre.start && nowSeconds <= periods.pre.end) return "pre_market";
  if (periods?.regular?.start && periods.regular.end && nowSeconds >= periods.regular.start && nowSeconds <= periods.regular.end) return "regular";
  if (periods?.post?.start && periods.post.end && nowSeconds >= periods.post.start && nowSeconds <= periods.post.end) return "after_hours";
  return "closed";
}

function freshnessFor(session: MarketQuote["session"], ageSeconds: number, cacheState: ProviderResult<unknown>["cacheState"]): MarketQuote["freshness"] {
  if (cacheState === "stale") return session === "closed" && ageSeconds <= 3 * 24 * 60 * 60 ? "cached" : "stale";
  if (cacheState === "memory" || cacheState === "edge") {
    if (session === "regular" || session === "pre_market" || session === "after_hours") {
      if (ageSeconds <= 15 * 60) return "near_live";
      if (ageSeconds <= 24 * 60 * 60) return "delayed";
      return "stale";
    }
    return ageSeconds <= 3 * 24 * 60 * 60 ? "cached" : ageSeconds <= 7 * 24 * 60 * 60 ? "cached" : "stale";
  }
  if (session === "regular" || session === "pre_market" || session === "after_hours") {
    if (ageSeconds <= 120) return "live";
    if (ageSeconds <= 15 * 60) return "near_live";
    return "delayed";
  }
  if (ageSeconds <= 3 * 24 * 60 * 60) return "near_live";
  if (ageSeconds <= 7 * 24 * 60 * 60) return "cached";
  return "stale";
}

export async function getYahooQuoteBundle(
  symbol: string,
  securityId: string,
  venueCode: string,
  force = false,
  intradayRange: "1d" | "5d" = "5d",
  expectedPtsSession?: "pts_day" | "pts_night",
) {
  const fetchedAt = new Date().toISOString();
  const dailyFund = venueCode === "FUND";
  const japanBoardTask = venueCode === "TSE" ? getYahooJapanBoard(symbol, force).catch(() => null) : Promise.resolve(null);
  const tokyoParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => tokyoParts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday");
  const minuteOfDay = Number(part("hour")) * 60 + Number(part("minute"));
  const likelyTseSession = venueCode === "TSE" && !["Sat", "Sun"].includes(weekday) && ((minuteOfDay >= 9 * 60 && minuteOfDay <= 11 * 60 + 30) || (minuteOfDay >= 12 * 60 + 30 && minuteOfDay <= 15 * 60 + 30));
  const newYorkParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const nyPart = (type: Intl.DateTimeFormatPartTypes) => newYorkParts.find((item) => item.type === type)?.value ?? "";
  const nyMinute = Number(nyPart("hour")) * 60 + Number(nyPart("minute"));
  const likelyUsSession = (venueCode === "US" || venueCode === "INDEX") && !["Sat", "Sun"].includes(nyPart("weekday")) && nyMinute >= 4 * 60 && nyMinute <= 20 * 60;
  const likelyActiveSession = likelyTseSession || likelyUsSession || venueCode === "GLOBAL";
  const providerResult = await fetchChart(symbol, { interval: dailyFund ? "1d" : "15m", range: dailyFund ? "1mo" : intradayRange, events: "div,splits" }, likelyActiveSession ? ACTIVE_QUOTE_TTL_MS : CLOSED_QUOTE_TTL_MS, force);
  const result = providerResult.value;
  const last = latestClose(result);
  const metaPrice = finiteNumber(result.meta?.regularMarketPrice);
  const metaTimestamp = finiteNumber(result.meta?.regularMarketTime);
  const nowSeconds = Date.now() / 1000;
  const session = dailyFund ? "closed" : sessionAt(nowSeconds, result);
  const price = session === "closed" ? metaPrice ?? last?.price : last?.price ?? metaPrice;
  const timestamp = session === "closed" ? metaTimestamp ?? last?.timestamp : last?.timestamp ?? metaTimestamp;
  if (price == null || price <= 0 || timestamp == null) throw new MarketDataError(`${symbol}: no usable market price`);

  const previousClose = finiteNumber(result.meta?.previousClose) ?? finiteNumber(result.meta?.chartPreviousClose) ?? undefined;
  const changeRatio = previousClose && previousClose > 0 ? Math.abs(price / previousClose - 1) : 0;
  const hasRecentSplit = Object.keys(result.events?.splits ?? {}).length > 0;
  const validationStatus: MarketQuote["validationStatus"] = changeRatio > 0.35 && !hasRecentSplit ? "suspect" : "valid";
  const ageSeconds = Math.max(0, nowSeconds - timestamp);
  const quote: MarketQuote = {
    price: String(price),
    ...(previousClose != null ? { previousRegularClose: String(previousClose) } : {}),
    ...(finiteNumber(result.meta?.regularMarketOpen) != null ? { dayOpen: String(result.meta?.regularMarketOpen) } : {}),
    ...(finiteNumber(result.meta?.regularMarketDayHigh) != null ? { dayHigh: String(result.meta?.regularMarketDayHigh) } : {}),
    ...(finiteNumber(result.meta?.regularMarketDayLow) != null ? { dayLow: String(result.meta?.regularMarketDayLow) } : {}),
    ...(finiteNumber(result.meta?.regularMarketVolume) != null ? { dayVolume: String(result.meta?.regularMarketVolume) } : {}),
    marketTimestamp: secondsToIso(timestamp),
    fetchedAt,
    freshness: dailyFund ? providerResult.cacheState === "stale" ? "stale" : providerResult.cacheState === "memory" || providerResult.cacheState === "edge" ? "cached" : "delayed" : freshnessFor(session, ageSeconds, providerResult.cacheState),
    provider: `yahoo_chart_unofficial:${providerResult.host}`,
    session,
    priceType: session === "closed" ? "official_close" : ageSeconds <= 15 * 60 ? "last_trade" : "delayed_last",
    venueCode,
    validationStatus,
  };
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const intraday: IntradayBar[] = [];
  for (let index = 0; !dailyFund && index < Math.min(timestamps.length, closes.length); index += 1) {
    const barTimestamp = finiteNumber(timestamps[index]);
    const close = finiteNumber(closes[index]);
    if (barTimestamp == null || close == null || close <= 0) continue;
    intraday.push({
      securityId,
      timestamp: secondsToIso(barTimestamp),
      price: String(close),
      provider: `yahoo_chart_unofficial:${providerResult.host}`,
    });
  }
  const lastIntraday = intraday.at(-1);
  if (!dailyFund && (!lastIntraday || lastIntraday.timestamp !== quote.marketTimestamp)) {
    intraday.push({ securityId, timestamp: quote.marketTimestamp, price: quote.price, provider: quote.provider });
  }
  const japanBoard = await japanBoardTask;
  if (venueCode === "TSE" && japanBoard?.board) {
    const ptsPrice = numericText(japanBoard.board.ptsPrice);
    const ptsTimestamp = tokyoPtsTimestamp(japanBoard.board.ptsUpdateTime);
    const ptsAgeSeconds = ptsTimestamp == null ? Number.POSITIVE_INFINITY : Date.now() / 1000 - new Date(ptsTimestamp).getTime() / 1000;
    const hasPtsTrade = expectedPtsSession !== "pts_day" && ptsPrice != null && ptsPrice > 0 && ptsTimestamp != null && ptsAgeSeconds >= -120 && ptsAgeSeconds <= 13 * 60 * 60;
    if (hasPtsTrade) {
      quote.price = String(ptsPrice);
      quote.session = "pts_night";
      quote.venueCode = "JNX";
      quote.marketTimestamp = ptsTimestamp;
      quote.provider = `yahoo_japan_pts_html:${japanBoard.cacheState}`;
      quote.priceType = ptsAgeSeconds <= 15 * 60 ? "last_trade" : "delayed_last";
      const lastBar = intraday.at(-1);
      if (!lastBar || lastBar.timestamp !== quote.marketTimestamp) {
        intraday.push({ securityId, timestamp: quote.marketTimestamp, price: quote.price, provider: quote.provider });
      }
    }
  }
  const exchangeLabel = japanBoard?.board.label ?? result.meta?.exchangeName;
  return {
    quote,
    intraday,
    ...(exchangeLabel ? { exchangeLabel } : {}),
    ...(result.meta?.shortName ? { shortName: result.meta.shortName } : {}),
    ...(result.meta?.longName ? { longName: result.meta.longName } : {}),
  };
}

export async function getYahooQuote(symbol: string, venueCode: string, force = false) {
  return (await getYahooQuoteBundle(symbol, symbol, venueCode, force)).quote;
}

export async function getYahooJapanQuoteBundle(symbol: string, securityId: string, force = false, expectedSession?: "pts_day" | "pts_night") {
  if (!/^(?:[0-9]{4}|[0-9]{3}[A-Z])\.T$/u.test(symbol)) throw new MarketDataError("Invalid Yahoo Japan symbol");
  const { board, cacheState } = await getYahooJapanBoard(symbol, force);
  const regularPrice = numericText(board.price?.value);
  const ptsPrice = numericText(board.ptsPrice);
  const ptsTimestamp = tokyoPtsTimestamp(board.ptsUpdateTime);
  const ptsAgeSeconds = ptsTimestamp == null ? Number.POSITIVE_INFINITY : Date.now() / 1000 - new Date(ptsTimestamp).getTime() / 1000;
  const hasPtsTrade = expectedSession !== "pts_day" && ptsPrice != null && ptsPrice > 0 && ptsTimestamp != null && ptsAgeSeconds >= -120 && ptsAgeSeconds <= 13 * 60 * 60;
  const price = hasPtsTrade ? ptsPrice : regularPrice;
  const change = numericText(board.priceChange?.value);
  if (price == null || price <= 0) throw new MarketDataError(`${symbol}: Yahoo Japan price unavailable`);
  const previousClose = change == null || regularPrice == null ? null : regularPrice - change;
  const marketTimestamp = hasPtsTrade ? ptsTimestamp : tokyoMarketTimestamp(board.japanUpdateTime);
  const timestampSeconds = new Date(marketTimestamp).getTime() / 1000;
  const session: MarketQuote["session"] = expectedSession ?? (hasPtsTrade ? "pts_night" : tseSessionNow());
  const ageSeconds = Math.max(0, Date.now() / 1000 - timestampSeconds);
  const provider = hasPtsTrade ? `yahoo_japan_pts_html:${cacheState}` : `yahoo_japan_html:${cacheState}`;
  const quote: MarketQuote = {
    price: String(price),
    ...(previousClose != null && previousClose > 0 ? { previousRegularClose: String(previousClose) } : {}),
    marketTimestamp,
    fetchedAt: new Date().toISOString(),
    freshness: cacheState === "stale" ? "stale" : ageSeconds <= 15 * 60 ? "near_live" : ageSeconds <= 24 * 60 * 60 ? "delayed" : "cached",
    provider,
    session,
    priceType: hasPtsTrade ? (ageSeconds <= 15 * 60 ? "last_trade" : "delayed_last") : "official_close",
    venueCode: hasPtsTrade ? "JNX" : "TSE",
    validationStatus: "valid",
  };
  return {
    quote,
    intraday: [{ securityId, timestamp: marketTimestamp, price: quote.price, provider } satisfies IntradayBar],
    ...(board.label ? { exchangeLabel: board.label } : {}),
  };
}

export async function getYahooHistory(
  symbol: string,
  securityId: string,
  period1: number,
  period2: number,
  force = false,
) {
  const providerResult = await fetchChart(
    symbol,
    { interval: "1d", period1: String(period1), period2: String(period2), events: "div,splits", includeAdjustedClose: "true" },
    6 * 60 * 60 * 1000,
    force,
  );
  const result = providerResult.value;
  const firstTradeTimestamp = finiteNumber(result.meta?.firstTradeDate);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjustedCloses = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: MarketBar[] = [];
  for (let index = 0; index < Math.min(timestamps.length, closes.length); index += 1) {
    const timestamp = finiteNumber(timestamps[index]);
    const close = finiteNumber(closes[index]);
    if (timestamp == null || close == null || close <= 0) continue;
    const adjustedClose = finiteNumber(adjustedCloses[index]);
    bars.push({
      securityId,
      date: ymdInTokyo(timestamp),
      close: String(close),
      ...(adjustedClose != null && adjustedClose > 0 ? { adjustedClose: String(adjustedClose) } : {}),
      provider: `yahoo_chart_unofficial:${providerResult.host}`,
    });
  }

  const corporateActions: CorporateAction[] = [];
  for (const [eventKey, split] of Object.entries(result.events?.splits ?? {})) {
    const timestamp = finiteNumber(split.date) ?? finiteNumber(Number(eventKey));
    const numerator = finiteNumber(split.numerator);
    const denominator = finiteNumber(split.denominator);
    if (timestamp == null || numerator == null || denominator == null || numerator <= 0 || denominator <= 0) continue;
    corporateActions.push({
      id: `${securityId}-split-${timestamp}`,
      securityId,
      type: numerator >= denominator ? "SPLIT" : "REVERSE_SPLIT",
      effectiveDate: ymdInTokyo(timestamp),
      numerator: String(numerator),
      denominator: String(denominator),
      sourceProvider: `yahoo_chart_unofficial:${providerResult.host}`,
    });
  }
  return {
    bars,
    corporateActions,
    ...(firstTradeTimestamp != null ? { inceptionDate: ymdInTokyo(firstTradeTimestamp) } : {}),
    cacheState: providerResult.cacheState,
    providerHost: providerResult.host,
  };
}
