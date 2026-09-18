import type { CorporateAction, DistributionEvent, IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";

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
    dividends?: Record<string, { amount?: number; date?: number }>;
    capitalGains?: Record<string, { amount?: number; date?: number }>;
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
const MAX_PROVIDER_CONCURRENCY = 6;
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
  // Japan has no daylight-saving transitions in the provider's history range.
  // Constructing an Intl formatter per bar exhausted Workers Free CPU while
  // normalizing years of daily prices and dividend events.
  return new Date((value + 9 * 60 * 60) * 1000).toISOString().slice(0, 10);
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
    return timestamp != null && (!Number.isFinite(end) || timestamp <= end);
  }));
  const sliceCashEvents = (events: Record<string, { amount?: number; date?: number }> | undefined) => Object.fromEntries(
    Object.entries(events ?? {}).filter(([key, item]) => {
      const timestamp = finiteNumber(item.date) ?? finiteNumber(Number(key));
      return timestamp != null && (!Number.isFinite(end) || timestamp <= end);
    }),
  );
  return {
    ...result,
    timestamp: indexes.map((index) => timestamps[index]),
    indicators: {
      ...result.indicators,
      quote: [{ ...(result.indicators?.quote?.[0] ?? {}), close: indexes.map((index) => closes[index] ?? null) }],
      adjclose: [{ ...(result.indicators?.adjclose?.[0] ?? {}), adjclose: indexes.map((index) => adjusted[index] ?? null) }],
    },
    events: {
      ...result.events,
      splits,
      dividends: sliceCashEvents(result.events?.dividends),
      capitalGains: sliceCashEvents(result.events?.capitalGains),
    },
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
      dividends: { ...(existing.events?.dividends ?? {}), ...(incoming.events?.dividends ?? {}) },
      capitalGains: { ...(existing.events?.capitalGains ?? {}), ...(incoming.events?.capitalGains ?? {}) },
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

export function tokyoPtsTimestamp(value: string | undefined, now = new Date()) {
  const clean = value?.trim();
  if (!clean) return null;

  const match = /^(?:(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})$/u.exec(clean);
  if (!match) return null;

  const tokyoParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => tokyoParts.find((item) => item.type === type)?.value ?? "";
  const currentYear = Number(part("year"));
  const currentMonth = Number(part("month"));
  const currentDay = Number(part("day"));
  const weekday = part("weekday");
  const currentMinute = Number(part("hour")) * 60 + Number(part("minute"));

  const hasDate = match[2] != null && match[3] != null;
  const rawMonth = hasDate ? Number(match[2]) : currentMonth;
  const rawDay = hasDate ? Number(match[3]) : currentDay;
  let year = match[1] ? Number(match[1]) : currentYear;
  if (!match[1]) {
    if (currentMonth === 1 && rawMonth === 12) year -= 1;
    else if (currentMonth === 12 && rawMonth === 1) year += 1;
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const tradeMinute = hour * 60 + minute;

  const d = new Date(Date.UTC(year, rawMonth - 1, rawDay, hour - 9, minute));
  if (!hasDate) {
    let daysToSubtract = 0;
    if (weekday === "Sat") {
      daysToSubtract = 1;
    } else if (weekday === "Sun") {
      daysToSubtract = 2;
    } else if (tradeMinute > currentMinute) {
      daysToSubtract = weekday === "Mon" ? 3 : 1;
    }
    if (daysToSubtract > 0) {
      d.setUTCDate(d.getUTCDate() - daysToSubtract);
    }
  }
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
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

export function tokyoMarketTimestamp(updateTime: string | undefined, now = new Date()) {
  const clean = updateTime?.trim();
  if (!clean) return now.toISOString();

  const tokyoParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => tokyoParts.find((item) => item.type === type)?.value ?? "";
  const currentYear = Number(part("year"));
  const currentMonth = Number(part("month"));
  const currentDay = Number(part("day"));
  const weekday = part("weekday");
  const currentMinute = Number(part("hour")) * 60 + Number(part("minute"));

  // Format 1: YYYY/M/D H:mm or M/D H:mm or YYYY/M/D or M/D
  const dateMatch = /^(?:(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2}))(?:\s+(\d{1,2}):(\d{2}))?$/u.exec(clean);
  if (dateMatch) {
    const rawMonth = Number(dateMatch[2]);
    const rawDay = Number(dateMatch[3]);
    let year = dateMatch[1] ? Number(dateMatch[1]) : currentYear;
    if (!dateMatch[1]) {
      if (currentMonth === 1 && rawMonth === 12) year -= 1;
      else if (currentMonth === 12 && rawMonth === 1) year += 1;
    }
    // Default hour/minute to TSE official close at 15:30 JST (06:30 UTC) if omitted
    const hour = dateMatch[4] != null ? Number(dateMatch[4]) : 15;
    const minute = dateMatch[5] != null ? Number(dateMatch[5]) : 30;
    const d = new Date(Date.UTC(year, rawMonth - 1, rawDay, hour - 9, minute));
    return Number.isFinite(d.getTime()) ? d.toISOString() : now.toISOString();
  }

  // Format 2: H:mm
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(clean);
  if (timeMatch) {
    const uHour = Number(timeMatch[1]);
    const uMin = Number(timeMatch[2]);
    const updateMinute = uHour * 60 + uMin;

    let daysToSubtract = 0;
    if (weekday === "Sat") {
      daysToSubtract = 1;
    } else if (weekday === "Sun") {
      daysToSubtract = 2;
    } else if (currentMinute < updateMinute) {
      daysToSubtract = weekday === "Mon" ? 3 : 1;
    }

    const d = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay, uHour - 9, uMin));
    if (daysToSubtract > 0) {
      d.setUTCDate(d.getUTCDate() - daysToSubtract);
    }
    return Number.isFinite(d.getTime()) ? d.toISOString() : now.toISOString();
  }

  return now.toISOString();
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

function ptsSessionNow(now = new Date()): "pts_day" | "pts_night" | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday");
  const minute = Number(part("hour")) * 60 + Number(part("minute"));

  // Tue-Sat 00:00 - 06:00 is night PTS from previous business day
  if (minute < 6 * 60 && !["Sun", "Mon"].includes(weekday)) {
    return "pts_night";
  }
  if (["Sat", "Sun"].includes(weekday)) return null;
  // Mon-Fri 08:20 - 16:30 (pts day: 08:20-09:00, 11:30-12:30 lunch, 15:30-16:30 post-TSE)
  if (
    (minute >= 8 * 60 + 20 && minute < 9 * 60) ||
    (minute >= 11 * 60 + 30 && minute < 12 * 60 + 30) ||
    (minute >= 15 * 60 + 30 && minute < 16 * 60 + 30)
  ) {
    return "pts_day";
  }
  // Mon-Fri 17:00 - 24:00 (pts night)
  if (minute >= 17 * 60) {
    return "pts_night";
  }
  return null;
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
  intradayRange: "1d" | "5d" = "1d",
  expectedPtsSession?: "pts_day" | "pts_night",
) {
  const fetchedAt = new Date().toISOString();
  const dailyFund = venueCode === "FUND";
  const shouldFetchJapanBoard = venueCode === "TSE" && (
    expectedPtsSession === "pts_day" ||
    expectedPtsSession === "pts_night" ||
    (tseSessionNow() === "closed" && force)
  );
  const japanBoardTask = shouldFetchJapanBoard
    ? getYahooJapanBoard(symbol, force).catch(() => null)
    : Promise.resolve(null);
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
  const providerResult = await fetchChart(symbol, { interval: dailyFund ? "1d" : "5m", range: dailyFund ? "1mo" : intradayRange, events: "div,splits" }, likelyActiveSession ? ACTIVE_QUOTE_TTL_MS : CLOSED_QUOTE_TTL_MS, force);
  const result = providerResult.value;
  const last = latestClose(result);
  const metaPrice = finiteNumber(result.meta?.regularMarketPrice);
  const metaTimestamp = finiteNumber(result.meta?.regularMarketTime);
  const nowSeconds = Date.now() / 1000;
  const session = dailyFund ? "closed" : sessionAt(nowSeconds, result);
  const lastIsNewer = last != null && last.timestamp != null && (metaTimestamp == null || last.timestamp > metaTimestamp);
  let price = (lastIsNewer || session !== "closed") ? (last?.price ?? metaPrice) : (metaPrice ?? last?.price);
  let timestamp = (lastIsNewer || session !== "closed") ? (last?.timestamp ?? metaTimestamp) : (metaTimestamp ?? last?.timestamp);

  const previousClose = finiteNumber(result.meta?.previousClose) ?? finiteNumber(result.meta?.chartPreviousClose) ?? undefined;
  const hasRecentSplit = Object.keys(result.events?.splits ?? {}).length > 0;

  if (
    price != null &&
    metaPrice != null &&
    metaPrice > 0 &&
    price !== metaPrice &&
    previousClose &&
    previousClose > 0 &&
    !hasRecentSplit &&
    Math.abs(price / previousClose - 1) > 0.35 &&
    Math.abs(metaPrice / previousClose - 1) <= 0.35
  ) {
    price = metaPrice;
    timestamp = metaTimestamp ?? timestamp;
  }

  if (price == null || price <= 0 || timestamp == null) throw new MarketDataError(`${symbol}: no usable market price`);

  const changeRatio = previousClose && previousClose > 0 ? Math.abs(price / previousClose - 1) : 0;
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
    const regularPrice = numericText(japanBoard.board.price?.value);
    const ptsTimestamp = tokyoPtsTimestamp(japanBoard.board.ptsUpdateTime);
    const ptsAgeSeconds = ptsTimestamp == null ? Number.POSITIVE_INFINITY : Date.now() / 1000 - new Date(ptsTimestamp).getTime() / 1000;
    const isPtsSessionActive = expectedPtsSession === "pts_night" || expectedPtsSession === "pts_day";
    const ptsDeviation = ptsPrice != null && regularPrice != null && regularPrice > 0 ? Math.abs(ptsPrice / regularPrice - 1) : 0;
    const ptsTime = ptsTimestamp ? new Date(ptsTimestamp).getTime() : 0;
    const tseTime = new Date(quote.marketTimestamp).getTime();
    const isTseRegular = tseSessionNow() === "regular";

    const hasPtsTrade = ptsPrice != null && ptsPrice > 0 && ptsTimestamp != null && ptsAgeSeconds >= -120 && ptsDeviation <= 0.20 && (
      isTseRegular
        ? ptsTime > tseTime && ptsAgeSeconds <= 15 * 60
        : ptsTime >= tseTime - 60_000 && ptsAgeSeconds <= 5 * 24 * 60 * 60
    );
    if (hasPtsTrade) {
      quote.price = String(ptsPrice);
      quote.session = expectedPtsSession ?? (ptsSessionNow() ?? (isTseRegular ? "regular" : "closed"));
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
  const regularTimestamp = tokyoMarketTimestamp(board.japanUpdateTime);
  const ptsAgeSeconds = ptsTimestamp == null ? Number.POSITIVE_INFINITY : Date.now() / 1000 - new Date(ptsTimestamp).getTime() / 1000;
  const ptsDeviation = ptsPrice != null && regularPrice != null && regularPrice > 0 ? Math.abs(ptsPrice / regularPrice - 1) : 0;
  const ptsTime = ptsTimestamp ? new Date(ptsTimestamp).getTime() : 0;
  const regularTime = new Date(regularTimestamp).getTime();
  const isTseRegular = tseSessionNow() === "regular";

  const hasPtsTrade = ptsPrice != null && ptsPrice > 0 && ptsTimestamp != null && ptsAgeSeconds >= -120 && ptsDeviation <= 0.20 && (
    isTseRegular
      ? ptsTime > regularTime && ptsAgeSeconds <= 15 * 60
      : ptsTime >= regularTime - 60_000 && ptsAgeSeconds <= 5 * 24 * 60 * 60
  );
  const price = hasPtsTrade ? ptsPrice : regularPrice;
  const change = numericText(board.priceChange?.value);
  if (price == null || price <= 0) throw new MarketDataError(`${symbol}: Yahoo Japan price unavailable`);
  const previousClose = change == null || regularPrice == null ? null : regularPrice - change;
  const marketTimestamp = hasPtsTrade ? ptsTimestamp : regularTimestamp;
  const timestampSeconds = new Date(marketTimestamp).getTime() / 1000;
  const session: MarketQuote["session"] = expectedSession ?? (hasPtsTrade ? (ptsSessionNow() ?? (isTseRegular ? "regular" : "closed")) : tseSessionNow());
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
  distributionsOnly = false,
) {
  const fiveYearsAgo = Math.floor((Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) / 1000);
  const fetchPeriod1 = Math.min(period1, fiveYearsAgo);
  const providerResult = await fetchChart(
    symbol,
    { interval: distributionsOnly ? "1mo" : "1d", period1: String(fetchPeriod1), period2: String(period2), events: "capitalGain|div|split", includeAdjustedClose: distributionsOnly ? "false" : "true" },
    6 * 60 * 60 * 1000,
    force,
  );
  const result = providerResult.value;
  const firstTradeTimestamp = finiteNumber(result.meta?.firstTradeDate);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjustedCloses = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: MarketBar[] = [];
  for (let index = 0; !distributionsOnly && index < Math.min(timestamps.length, closes.length); index += 1) {
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
  const distributions: DistributionEvent[] = [];
  const currency = result.meta?.currency ?? (symbol.endsWith(".T") ? "JPY" : "USD");
  const appendDistributions = (
    source: Record<string, { amount?: number; date?: number }> | undefined,
    type: DistributionEvent["type"],
  ) => {
    for (const [eventKey, item] of Object.entries(source ?? {})) {
      const timestamp = finiteNumber(item.date) ?? finiteNumber(Number(eventKey));
      const amount = finiteNumber(item.amount);
      if (timestamp == null || amount == null || amount < 0) continue;
      const date = ymdInTokyo(timestamp);
      distributions.push({
        id: `${securityId}-${type.toLowerCase()}-${timestamp}`,
        securityId,
        type,
        exDate: date,
        amountPerUnit: String(amount),
        distributionUnit: "1",
        currency,
        sourceProvider: `yahoo_chart_unofficial:${providerResult.host}`,
        sourceUrl: chartUrl(providerResult.host === "edge" ? hosts[0] : providerResult.host, symbol, { interval: distributionsOnly ? "1mo" : "1d", period1: String(fetchPeriod1), period2: String(period2), events: "capitalGain|div|split" }),
        confidence: "reported",
        status: "estimated",
        fetchedAt: new Date().toISOString(),
      });
    }
  };
  appendDistributions(result.events?.dividends, "CASH_DIVIDEND");
  appendDistributions(result.events?.capitalGains, "CAPITAL_GAIN_DISTRIBUTION");
  return {
    bars,
    corporateActions,
    distributions,
    ...(firstTradeTimestamp != null ? { inceptionDate: ymdInTokyo(firstTradeTimestamp) } : {}),
    cacheState: providerResult.cacheState,
    providerHost: providerResult.host,
  };
}
