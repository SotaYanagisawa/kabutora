import type { DistributionEvent, IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";
import type { JapanFundSearchResult } from "./japan-fund-catalog";

type FundPage = {
  code: string;
  name: string;
  nickname?: string;
  price: number;
  previousPrice: number;
  priceDate: string;
  token: string;
  cookie?: string;
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
const historyCache = new Map<string, CacheEntry<{ bars: MarketBar[]; distributions: DistributionEvent[] }>>();
const distributionCache = new Map<string, CacheEntry<DistributionEvent[]>>();
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

function yahooPageSources(html: string) {
  const sources = [html];
  const flightChunk = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)<\/script>/gu;
  for (const match of html.matchAll(flightChunk)) {
    try {
      sources.push(JSON.parse(match[1]) as string);
    } catch {}
  }
  return sources;
}

function yahooSessionCookie(headers: Headers) {
  const compatibleHeaders = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  const values = compatibleHeaders.getSetCookie?.()
    ?? compatibleHeaders.getAll?.("set-cookie")
    ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  const cookies = new Map<string, string>();
  for (const value of values) {
    for (const match of value.matchAll(/(?:^|,\s*)(A|XA|B|XB)=([^;]+)/gu)) cookies.set(match[1], match[2]);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
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
  const match = /^(\d{1,2})\/(\d{1,2})$/u.exec(monthDay);
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
  const sources = yahooPageSources(html);
  const legacySource = sources.find((source) => source.includes('"fundPrices":{'));
  const currentSource = sources.find((source) => source.includes('"priceBoard":{'));
  const source = legacySource ?? currentSource;
  if (!source) return null;
  const legacy = Boolean(legacySource);
  const boardMarker = legacy ? '"fundPrices":{' : '"priceBoard":{';
  const boardStart = source.indexOf(boardMarker);
  const board = source.slice(boardStart, boardStart + 2_500);
  const code = jsonStringField(board, "code");
  const marketName = jsonStringField(board, "marketName");
  const name = jsonStringField(board, "name");
  const nickname = jsonStringField(board, legacy ? "fundNickName" : "nickName");
  const updateDate = jsonStringField(board, "updateDate");
  const priceText = jsonStringField(board, legacy ? "price" : "value");
  const changeText = jsonStringField(board, "changePrice");
  const token = sources.map((candidate) => jsonStringField(candidate, "jwtToken")).find(Boolean) ?? null;
  const priceDate = updateDate ? closestPastFundDate(updateDate, now) : null;
  const price = Number(priceText?.replaceAll(",", ""));
  const change = Number(changeText?.replaceAll(",", ""));
  if (code?.toUpperCase() !== expectedCode.toUpperCase() || (legacy && marketName !== "投資信託") || !name || !token || !priceDate || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) return null;
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

function normalizedFundDistributionDate(value: string) {
  const match = /^(20\d{2})\/(\d{1,2})\/(\d{1,2})$/u.exec(value);
  if (!match) return null;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()) ? null : date;
}

function fundDistributionEvent(code: string, securityId: string, dateText: string, amountText: string, sourceProvider: string, sourceUrl: string, confidence: DistributionEvent["confidence"]): DistributionEvent | null {
  const date = normalizedFundDistributionDate(dateText);
  const amount = Number(amountText.replaceAll(",", ""));
  if (!date || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: `${securityId}-fund-distribution-${date}`,
    securityId,
    type: "FUND_DISTRIBUTION",
    exDate: date,
    amountPerUnit: String(amount),
    distributionUnit: "10000",
    currency: "JPY",
    sourceProvider,
    sourceUrl,
    confidence,
    status: "estimated",
    fetchedAt: new Date().toISOString(),
  };
}

export function parseYahooJapanFundDistributions(html: string, code: string, securityId: string): DistributionEvent[] {
  const sourceUrl = `https://finance.yahoo.co.jp/quote/${code}/dividendinfo`;
  const events: DistributionEvent[] = [];
  const table = /<table[^>]*aria-label="分配金実績のテーブル"[^>]*>([\s\S]*?)<\/table>/u.exec(html)?.[1] ?? "";
  for (const row of table.matchAll(/<tr[^>]*>[\s\S]*?<td[^>]*>(20\d{2}\/\d{1,2}\/\d{1,2})<\/td>[\s\S]*?_StyledNumber__value_[^>]*>([0-9,.]+)<\/span>[\s\S]*?<\/tr>/gu)) {
    const event = fundDistributionEvent(code, securityId, row[1], row[2], "yahoo_japan_fund_unofficial", sourceUrl, "reported");
    if (event) events.push(event);
  }
  for (const row of html.matchAll(/\\?"date\\?":\\?"(20\d{2}\/\d{1,2}\/\d{1,2})\\?",\\?"price\\?":\\?"([0-9,.]+)\\?"/gu)) {
    const event = fundDistributionEvent(code, securityId, row[1], row[2], "yahoo_japan_fund_unofficial", sourceUrl, "reported");
    if (event) events.push(event);
  }
  return [...new Map(events.map((event) => [event.id, event])).values()].sort((left, right) => left.exDate!.localeCompare(right.exDate!));
}

type BlackRockDistributionPayload = {
  table?: { aaData?: Array<Array<{ raw?: number | string; display?: string }>> };
};

export function parseBlackRockFundDistributions(payload: unknown, code: string, securityId: string, sourceUrl: string): DistributionEvent[] {
  const rows = (payload as BlackRockDistributionPayload | null)?.table?.aaData;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const rawDate = row?.[0]?.raw;
    const rawAmount = row?.[1]?.raw;
    const compactDate = typeof rawDate === "number" || typeof rawDate === "string" ? String(rawDate) : "";
    if (!/^20\d{6}$/u.test(compactDate)) return [];
    const dateText = `${compactDate.slice(0, 4)}/${compactDate.slice(4, 6)}/${compactDate.slice(6, 8)}`;
    const event = fundDistributionEvent(code, securityId, dateText, String(rawAmount ?? ""), "blackrock_official", sourceUrl, "official");
    return event ? [event] : [];
  }).sort((left, right) => left.exDate!.localeCompare(right.exDate!));
}

const BLACKROCK_DISTRIBUTION_PAGES: Record<string, string> = {
  "48314059": "https://www.blackrock.com/jp/individual/ja/products/261009/blackrock-global-equity-income-open",
};

async function requestBlackRockDistributions(code: string, securityId: string) {
  const productUrl = BLACKROCK_DISTRIBUTION_PAGES[code];
  if (!productUrl) return null;
  const pageResponse = await fetch(productUrl, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(12_000),
  });
  if (!pageResponse.ok) throw new Error(`BlackRock returned ${pageResponse.status}`);
  const pageHtml = await pageResponse.text();
  const endpoint = /data-ajaxuri="([^"]+1480664184454\.ajax\?tab=distributions&amp;fileType=json&amp;subtab=table)"/u.exec(pageHtml)?.[1]
    ?? /data-ajaxuri="([^"]+\.ajax\?tab=distributions&fileType=json&subtab=table)"/u.exec(pageHtml)?.[1];
  if (!endpoint) throw new Error("BlackRock distribution endpoint unavailable");
  const endpointUrl = new URL(endpoint.replaceAll("&amp;", "&"), productUrl).toString();
  const response = await fetch(endpointUrl, {
    cache: "no-store",
    headers: { Accept: "application/json", Referer: productUrl, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`BlackRock distributions returned ${response.status}`);
  const text = (await response.text()).replace(/^\uFEFF/u, "");
  const events = parseBlackRockFundDistributions(JSON.parse(text), code, securityId, endpointUrl);
  if (!events.length) throw new Error("BlackRock distributions were empty");
  return events;
}

async function requestFundDistributions(code: string, securityId: string, force: boolean) {
  const cached = distributionCache.get(code);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const official = await requestBlackRockDistributions(code, securityId);
    let events = official;
    if (!events) {
      const sourceUrl = `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}/dividendinfo`;
      const response = await fetch(sourceUrl, {
        cache: "no-store",
        headers: { Accept: "text/html", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Yahoo Japan fund distributions returned ${response.status}`);
      events = parseYahooJapanFundDistributions(await response.text(), code, securityId);
    }
    distributionCache.set(code, { value: events, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    return events;
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return cached.value;
    throw error;
  }
}

export async function getYahooJapanFundDistributions(code: string, securityId: string, force = false) {
  if (!/^[A-Z0-9]{8}$/u.test(code)) throw new Error("Invalid Japanese fund code");
  return requestFundDistributions(code, securityId, force);
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
    const parsedPage = parseYahooJapanFundPage(await response.text(), code);
    if (!parsedPage) throw new Error("fund price board unavailable");
    const cookie = yahooSessionCookie(response.headers);
    const page = cookie ? { ...parsedPage, cookie } : parsedPage;
    pageCache.set(code, { value: page, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    return { page, cacheState: "network" as const };
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { page: cached.value, cacheState: "stale" as const };
    throw error;
  }
}

export async function getYahooJapanFundQuoteBundle(code: string, securityId: string, force = false) {
  const cleanCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/u.test(cleanCode)) throw new Error("Invalid Japanese fund code");
  const { page, cacheState } = await fetchFundPage(cleanCode, force);
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
      page.cookie,
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

async function requestHistory(code: string, securityId: string, token: string, from: string, to: string, cookie?: string) {
  const url = new URL(`https://finance.yahoo.co.jp/bff-quote/v1/ajax/chart/ex/v1/main/fund/chart/history/${encodeURIComponent(code)}`);
  url.searchParams.set("fromDate", compactYmd(from));
  url.searchParams.set("size", String(MAX_DAILY_HISTORY_SIZE));
  url.searchParams.set("timeFrame", "daily");
  url.searchParams.set("toDate", compactYmd(to));
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Referer: `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}/chart`,
      "User-Agent": USER_AGENT,
      "jwt-token": token,
      ...(cookie ? { Cookie: cookie } : {}),
    },
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
  if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value, corporateActions: [], cacheState: "memory" as const };
  try {
    const { page } = await fetchFundPage(code, force);
    const chunks = historyWindows(from, to);
    const [incoming, distributions] = await Promise.all([
      Promise.all(chunks.map((chunk) => requestHistory(code, securityId, page.token, chunk.from, chunk.to, page.cookie))),
      requestFundDistributions(code, securityId, force).catch(() => []),
    ]);
    const bars = [...new Map(incoming.flat().map((bar) => [`${bar.securityId}:${bar.date}`, bar])).values()].sort((a, b) => a.date.localeCompare(b.date));
    historyCache.set(cacheKey, { value: { bars, distributions }, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    const requestedStart = new Date(`${from}T00:00:00Z`).getTime();
    const firstBar = new Date(`${bars[0].date}T00:00:00Z`).getTime();
    return {
      bars,
      corporateActions: [],
      distributions,
      ...(firstBar - requestedStart > 31 * 86_400_000 ? { inceptionDate: bars[0].date } : {}),
      cacheState: "network" as const,
    };
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { ...cached.value, corporateActions: [], cacheState: "stale" as const };
    throw error;
  }
}
