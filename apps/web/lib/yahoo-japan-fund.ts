import type { IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";
import type { JapanFundSearchResult } from "./japan-fund-catalog";

type FundPage = {
  code: string;
  name: string;
  nickname?: string;
  price: number;
  previousPrice: number;
  priceDate: string;
  token: string;
};

type FundHistoryPayload = {
  priceHistories?: Array<{
    baseDate?: string;
    closePrice?: number;
  }>;
  error?: Array<{ message?: string }>;
};

type CacheEntry<T> = { value: T; expiresAt: number; staleUntil: number };

export type YahooJapanFundSearchResult = JapanFundSearchResult;

const pageCache = new Map<string, CacheEntry<FundPage>>();
const historyCache = new Map<string, CacheEntry<MarketBar[]>>();
const USER_AGENT = "Kabutora/1.0 personal-portfolio-tracker";
const FUND_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DAILY_HISTORY_SIZE = 3000;

function jsonStringField(source: string, field: string) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`"${escapedField}":"((?:\\\\.|[^"\\\\])*)"`, "u").exec(source);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

export function parseYahooJapanFundSearch(html: string): YahooJapanFundSearchResult[] {
  const expression = /"detailLink":"https:\/\/finance\.yahoo\.co\.jp\/quote\/([A-Za-z0-9]{8})","code":"([A-Za-z0-9]{8})","marketName":"投資信託","name":"((?:\\.|[^"\\])*)"/gu;
  const results: YahooJapanFundSearchResult[] = [];
  for (const match of html.matchAll(expression)) {
    if (match[1].toUpperCase() !== match[2].toUpperCase()) continue;
    let name: string;
    try {
      name = JSON.parse(`"${match[3]}"`) as string;
    } catch {
      continue;
    }
    const code = match[1].toUpperCase();
    results.push({
      id: `sec-jp-fund-${code.toLowerCase()}`,
      displaySymbol: code,
      name,
      assetType: "fund",
      country: "JP",
      exchangeMic: "JPFD",
      exchangeName: "日本の投資信託",
      exchangeLabel: "投資信託",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      priceUnit: "10000",
      providerSymbols: { yahoo: code },
    });
  }
  return [...new Map(results.map((result) => [result.id, result])).values()];
}

function closestPastFundDate(monthDay: string, now: Date) {
  const match = /^(\d{2})\/(\d{2})$/u.exec(monthDay);
  if (!match) return null;
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now).split("-").map(Number);
  let year = nowParts[0];
  const month = Number(match[1]);
  const day = Number(match[2]);
  let candidate = new Date(Date.UTC(year, month - 1, day, 6));
  const today = new Date(Date.UTC(nowParts[0], nowParts[1] - 1, nowParts[2], 6));
  if (candidate.getTime() - today.getTime() > 14 * 86_400_000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month - 1, day, 6));
  }
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseYahooJapanFundPage(html: string, expectedCode: string, now = new Date()): FundPage | null {
  const boardStart = html.indexOf('"fundPrices":{');
  if (boardStart < 0) return null;
  const board = html.slice(boardStart, boardStart + 2_500);
  const code = jsonStringField(board, "code");
  const marketName = jsonStringField(board, "marketName");
  const name = jsonStringField(board, "name");
  const nickname = jsonStringField(board, "fundNickName");
  const updateDate = jsonStringField(board, "updateDate");
  const priceText = jsonStringField(board, "price");
  const changeText = jsonStringField(board, "changePrice");
  const token = jsonStringField(html, "jwtToken");
  const priceDate = updateDate ? closestPastFundDate(updateDate, now) : null;
  const price = Number(priceText?.replaceAll(",", ""));
  const change = Number(changeText?.replaceAll(",", ""));
  if (code?.toUpperCase() !== expectedCode.toUpperCase() || marketName !== "投資信託" || !name || !token || !priceDate || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) return null;
  const previousPrice = price - change;
  if (!Number.isFinite(previousPrice) || previousPrice <= 0) return null;
  return { code: code.toUpperCase(), name, ...(nickname ? { nickname } : {}), price, previousPrice, priceDate, token };
}

export function parseYahooJapanFundHistory(payload: unknown, securityId: string): MarketBar[] {
  const histories = (payload as FundHistoryPayload | null)?.priceHistories;
  if (!Array.isArray(histories)) return [];
  return histories.flatMap((item): MarketBar[] => {
    if (!item || typeof item.baseDate !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(item.baseDate)) return [];
    if (typeof item.closePrice !== "number" || !Number.isFinite(item.closePrice) || item.closePrice <= 0) return [];
    return [{ securityId, date: item.baseDate, close: String(item.closePrice), provider: "yahoo_japan_fund_unofficial" }];
  });
}

async function fetchFundPage(code: string, force: boolean) {
  const cached = pageCache.get(code);
  if (!force && cached && cached.expiresAt > Date.now()) return { page: cached.value, cacheState: "memory" as const };
  try {
    const response = await fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}/chart`, {
      cache: "no-store",
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Yahoo Japan returned ${response.status}`);
    const page = parseYahooJapanFundPage(await response.text(), code);
    if (!page) throw new Error("fund price board unavailable");
    pageCache.set(code, { value: page, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    return { page, cacheState: "network" as const };
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { page: cached.value, cacheState: "stale" as const };
    throw error;
  }
}

export async function getYahooJapanFundQuoteBundle(code: string, securityId: string, force = false) {
  if (!/^[A-Z0-9]{8}$/u.test(code)) throw new Error("Invalid Japanese fund code");
  const { page, cacheState } = await fetchFundPage(code, force);
  const marketTimestamp = new Date(`${page.priceDate}T15:00:00+09:00`).toISOString();
  let intraday: IntradayBar[] = [];
  try {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setUTCDate(fromDate.getUTCDate() - 45);
    const recentBars = await requestHistory(
      code,
      securityId,
      page.token,
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10),
    );
    intraday = recentBars.map((bar) => ({
      securityId,
      timestamp: `${bar.date}T15:00:00+09:00`,
      price: bar.close,
      provider: bar.provider,
    }));
  } catch {}
  const quote: MarketQuote = {
    price: String(page.price),
    previousRegularClose: String(page.previousPrice),
    dayOpen: String(page.price),
    dayHigh: String(page.price),
    dayLow: String(page.price),
    marketTimestamp,
    fetchedAt: new Date().toISOString(),
    freshness: cacheState === "network" ? "delayed" : cacheState === "stale" ? "stale" : "cached",
    provider: "yahoo_japan_fund_unofficial",
    session: "closed",
    priceType: "official_close",
    venueCode: "FUND",
    validationStatus: Math.abs(page.price / page.previousPrice - 1) > 0.5 ? "suspect" : "valid",
  };
  return {
    quote,
    intraday,
    shortName: page.nickname || page.name,
    longName: page.name,
    exchangeLabel: "投資信託",
  };
}

function ymdFromSeconds(value: number) {
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function compactYmd(value: string) {
  return value.replaceAll("-", "");
}

function historyWindows(from: string, to: string) {
  const result: Array<{ from: string; to: string }> = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCFullYear(chunkEnd.getUTCFullYear() + 8);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    result.push({ from: cursor.toISOString().slice(0, 10), to: chunkEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

async function requestHistory(code: string, securityId: string, token: string, from: string, to: string) {
  const url = new URL(`https://finance.yahoo.co.jp/bff-pc/v1/main/fund/chart/history/${encodeURIComponent(code)}`);
  url.searchParams.set("fromDate", compactYmd(from));
  url.searchParams.set("size", String(MAX_DAILY_HISTORY_SIZE));
  url.searchParams.set("timeFrame", "daily");
  url.searchParams.set("toDate", compactYmd(to));
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, "jwt-token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Yahoo Japan fund history returned ${response.status}`);
  const payload = await response.json() as FundHistoryPayload;
  if (payload.error?.length) throw new Error(payload.error[0]?.message || "Yahoo Japan fund history unavailable");
  const bars = parseYahooJapanFundHistory(payload, securityId);
  if (!bars.length) throw new Error(`${code}: no usable fund history`);
  return bars;
}

export async function getYahooJapanFundHistory(code: string, securityId: string, period1: number, period2: number, force = false) {
  if (!/^[A-Z0-9]{8}$/u.test(code)) throw new Error("Invalid Japanese fund code");
  const from = ymdFromSeconds(period1);
  const to = ymdFromSeconds(period2);
  const cacheKey = `${code}:${from}:${to}`;
  const cached = historyCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return { bars: cached.value, corporateActions: [], cacheState: "memory" as const };
  try {
    const { page } = await fetchFundPage(code, force);
    const chunks = historyWindows(from, to);
    const incoming = await Promise.all(chunks.map((chunk) => requestHistory(code, securityId, page.token, chunk.from, chunk.to)));
    const bars = [...new Map(incoming.flat().map((bar) => [`${bar.securityId}:${bar.date}`, bar])).values()].sort((a, b) => a.date.localeCompare(b.date));
    historyCache.set(cacheKey, { value: bars, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    const requestedStart = new Date(`${from}T00:00:00Z`).getTime();
    const firstBar = new Date(`${bars[0].date}T00:00:00Z`).getTime();
    return {
      bars,
      corporateActions: [],
      ...(firstBar - requestedStart > 31 * 86_400_000 ? { inceptionDate: bars[0].date } : {}),
      cacheState: "network" as const,
    };
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { bars: cached.value, corporateActions: [], cacheState: "stale" as const };
    throw error;
  }
}
