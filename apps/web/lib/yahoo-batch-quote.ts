import type { MarketQuote } from "@kabutora/domain";
import { MarketDataError } from "./yahoo-market";

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
  const price = finiteNumber(raw.regularMarketPrice);
  const timestamp = finiteNumber(raw.regularMarketTime);
  if (price == null || price <= 0 || timestamp == null) return null;

  const previousClose = finiteNumber(raw.regularMarketPreviousClose);
  const changeRatio = previousClose && previousClose > 0 ? Math.abs(price / previousClose - 1) : 0;
  const validationStatus: MarketQuote["validationStatus"] = changeRatio > 0.35 ? "suspect" : "valid";

  const session = parseSession(raw.marketState);
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
  const failures: string[] = [];

  for (const host of hosts) {
    try {
      const url = new URL(`https://${host}/v7/finance/quote`);
      url.searchParams.set("symbols", cleanSymbols.join(","));
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: signal ?? AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
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
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return results;
}
