import { providerFetch } from "./server/market/provider-fetch";
import type { MarketQuote } from "@kabutora/domain";
import { MarketDataError } from "./yahoo-market";
import { fetchCnbcBatchQuotes } from "./cnbc-quote-provider";

export type YahooBatchRawQuote = {
  symbol?: string;
  shortName?: string;
  longName?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  currency?: string;
  marketState?: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  preMarketPrice?: number;
  preMarketTime?: number;
  postMarketPrice?: number;
  postMarketTime?: number;
  firstTradeDateMilliseconds?: number;
};

type YahooBatchPayload = {
  quoteResponse?: {
    result?: YahooBatchRawQuote[] | null;
    error?: { code?: string; description?: string } | null;
  };
};

const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const USER_AGENT = "Kabutora/1.0 personal-portfolio-tracker";

function secondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSession(marketState: string | undefined): MarketQuote["session"] {
  switch (marketState?.toUpperCase()) {
    case "REGULAR":
      return "regular";
    case "PRE":
      return "pre_market";
    case "POST":
    case "POSTPOST":
      return "after_hours";
    case "CLOSED":
    case "PREPRE":
    default:
      return "closed";
  }
}

export function normalizeBatchQuote(
  raw: YahooBatchRawQuote,
  venueCode: string,
  fetchedAt = new Date().toISOString(),
  host = "query1",
): { quote: MarketQuote; shortName?: string; longName?: string; exchangeLabel?: string } | null {
  const regPrice = finiteNumber(raw.regularMarketPrice);
  const regTime = finiteNumber(raw.regularMarketTime);
  const prePrice = finiteNumber(raw.preMarketPrice);
  const preTime = finiteNumber(raw.preMarketTime);
  const postPrice = finiteNumber(raw.postMarketPrice);
  const postTime = finiteNumber(raw.postMarketTime);

  const session = parseSession(raw.marketState);

  let price = regPrice;
  let timestamp = regTime;

  if (session === "pre_market" && prePrice != null && prePrice > 0 && preTime != null) {
    price = prePrice;
    timestamp = preTime;
  } else if (session === "after_hours" && postPrice != null && postPrice > 0 && postTime != null) {
    price = postPrice;
    timestamp = postTime;
  } else if (session === "closed") {
    if (postPrice != null && postPrice > 0 && postTime != null && (regTime == null || postTime > regTime)) {
      price = postPrice;
      timestamp = postTime;
    }
  }

  if (price == null || price <= 0 || timestamp == null) return null;

  const previousClose = finiteNumber(raw.regularMarketPreviousClose);
  const changeRatio = previousClose && previousClose > 0 ? Math.abs(price / previousClose - 1) : 0;
  const validationStatus: MarketQuote["validationStatus"] = changeRatio > 0.35 ? "suspect" : "valid";
  const ageSeconds = Math.max(0, Date.now() / 1000 - timestamp);
  const freshness: MarketQuote["freshness"] =
    session === "closed"
      ? ageSeconds <= 3 * 24 * 60 * 60
        ? "cached"
        : "stale"
      : ageSeconds <= 120
      ? "live"
      : ageSeconds <= 15 * 60
      ? "near_live"
      : "delayed";

  const quote: MarketQuote = {
    price: String(price),
    ...(previousClose != null && previousClose > 0 ? { previousRegularClose: String(previousClose) } : {}),
    ...(finiteNumber(raw.regularMarketOpen) != null ? { dayOpen: String(raw.regularMarketOpen) } : {}),
    ...(finiteNumber(raw.regularMarketDayHigh) != null ? { dayHigh: String(raw.regularMarketDayHigh) } : {}),
    ...(finiteNumber(raw.regularMarketDayLow) != null ? { dayLow: String(raw.regularMarketDayLow) } : {}),
    ...(finiteNumber(raw.regularMarketVolume) != null ? { dayVolume: String(raw.regularMarketVolume) } : {}),
    marketTimestamp: secondsToIso(timestamp),
    fetchedAt,
    freshness,
    provider: `yahoo_quote_batch:${host}`,
    session,
    priceType: session === "closed" ? "official_close" : ageSeconds <= 15 * 60 ? "last_trade" : "delayed_last",
    venueCode,
    validationStatus,
  };

  return {
    quote,
    ...(raw.shortName ? { shortName: raw.shortName } : {}),
    ...(raw.longName ? { longName: raw.longName } : {}),
    ...(raw.exchangeName || raw.fullExchangeName ? { exchangeLabel: raw.exchangeName ?? raw.fullExchangeName } : {}),
  };
}

export async function fetchYahooBatchQuotes(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, YahooBatchRawQuote>> {
  if (!symbols.length) return new Map();
  const cleanSymbols = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
  if (!cleanSymbols.length) return new Map();

  const results = new Map<string, YahooBatchRawQuote>();

  // Primary batch provider: CNBC REST batch endpoint (highly reliable and unauthenticated)
  try {
    const cnbcRawMap = await fetchCnbcBatchQuotes(cleanSymbols, signal);
    for (const [sym, raw] of cnbcRawMap) {
      const parseNum = (v: unknown) => {
        if (typeof v !== "string" && typeof v !== "number") return undefined;
        const n = Number(String(v).replaceAll(",", "").trim());
        return Number.isFinite(n) ? n : undefined;
      };
      const price = parseNum(raw.last);
      const prevClose = parseNum(raw.previous_day_closing);
      const timeSec = raw.last_time ? Math.floor(Date.parse(raw.last_time) / 1000) : Math.floor(Date.now() / 1000);
      const marketState = raw.curmktstatus === "REG_MKT"
        ? "REGULAR"
        : raw.curmktstatus === "PRE_MKT"
        ? "PRE"
        : raw.curmktstatus === "POST_MKT"
        ? "POST"
        : "CLOSED";

      results.set(sym.toUpperCase(), {
        symbol: raw.symbol ?? sym,
        shortName: raw.shortName,
        longName: raw.name,
        exchangeName: raw.exchange,
        currency: raw.currencyCode,
        marketState,
        regularMarketPrice: price,
        regularMarketPreviousClose: prevClose,
        regularMarketOpen: parseNum(raw.open),
        regularMarketDayHigh: parseNum(raw.high),
        regularMarketDayLow: parseNum(raw.low),
        regularMarketVolume: parseNum(raw.volume),
        regularMarketTime: timeSec,
      });
    }

    if (results.size === cleanSymbols.length) {
      return results;
    }
  } catch {}

  const missingSymbols = cleanSymbols.filter((s) => !results.has(s.toUpperCase()));
  if (!missingSymbols.length) return results;

  for (const host of hosts) {
    try {
      const url = new URL(`https://${host}/v7/finance/quote`);
      url.searchParams.set("symbols", missingSymbols.join(","));
      const response = await providerFetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: signal ?? AbortSignal.timeout(4_000),
      });

      if (!response.ok) {
        // If 401 Unauthorized or 403 Forbidden, Yahoo v7 quote is permanently locked; break out immediately
        if (response.status === 401 || response.status === 403) break;
        throw new MarketDataError(`${host} returned HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as YahooBatchPayload;
      const rawList = payload.quoteResponse?.result ?? [];

      for (const item of rawList) {
        if (item.symbol) {
          results.set(item.symbol.toUpperCase(), item);
        }
      }

      return results;
    } catch {
      break;
    }
  }

  return results;
}
