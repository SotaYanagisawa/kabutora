import type { MarketQuote } from "@kabutora/domain";

export type CnbcRawQuote = {
  symbol?: string;
  name?: string;
  shortName?: string;
  altName?: string;
  last?: string;
  last_time?: string;
  open?: string;
  high?: string;
  low?: string;
  change?: string;
  change_pct?: string;
  previous_day_closing?: string;
  volume?: string;
  exchange?: string;
  currencyCode?: string;
  curmktstatus?: string;
};

type CnbcPayload = {
  FormattedQuoteResult?: {
    FormattedQuote?: CnbcRawQuote[] | null;
  };
};

const CNBC_USER_AGENT = "Kabutora/1.0 (compatible; Mozilla/5.0)";
const DEFAULT_TIMEOUT_MS = 8_000;

export function mapYahooSymbolToCnbc(symbol: string): string {
  const trimmed = symbol.trim();
  if (trimmed === "^GSPC") return ".SPX";
  if (trimmed === "^IXIC") return ".IXIC";
  if (trimmed === "^DJI") return ".DJI";
  // Convert Berkshire style tickers like BRK-B to BRK.B
  return trimmed.replace(/-([A-Z0-9]+)$/u, ".$1").toUpperCase();
}

function parseNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).replaceAll(",", "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseIsoTimestamp(timeString: string | undefined, fallbackIso: string): string {
  if (!timeString) return fallbackIso;
  const parsed = Date.parse(timeString);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallbackIso;
}

function parseSession(status: string | undefined): MarketQuote["session"] {
  switch (status?.toUpperCase()) {
    case "REG_MKT":
      return "regular";
    case "PRE_MKT":
      return "pre_market";
    case "POST_MKT":
      return "after_hours";
    case "CLOSED":
    default:
      return "closed";
  }
}

export function parseCnbcQuote(
  raw: CnbcRawQuote,
  securityId: string,
  venueCode: string,
  fetchedAt = new Date().toISOString(),
): { quote: MarketQuote; shortName?: string; longName?: string; exchangeLabel?: string } | null {
  const price = parseNumber(raw.last);
  if (price == null || price <= 0) return null;

  const previousClose = parseNumber(raw.previous_day_closing);
  const changeRatio = previousClose && previousClose > 0 ? Math.abs(price / previousClose - 1) : 0;
  const validationStatus: MarketQuote["validationStatus"] = changeRatio > 0.35 ? "suspect" : "valid";

  const session = parseSession(raw.curmktstatus);
  const marketTimestamp = parseIsoTimestamp(raw.last_time, fetchedAt);
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(marketTimestamp)) / 1000);

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

  const dayOpen = parseNumber(raw.open);
  const dayHigh = parseNumber(raw.high);
  const dayLow = parseNumber(raw.low);
  const dayVolume = parseNumber(raw.volume);

  const quote: MarketQuote = {
    price: String(price),
    ...(previousClose != null && previousClose > 0 ? { previousRegularClose: String(previousClose) } : {}),
    ...(dayOpen != null && dayOpen > 0 ? { dayOpen: String(dayOpen) } : {}),
    ...(dayHigh != null && dayHigh > 0 ? { dayHigh: String(dayHigh) } : {}),
    ...(dayLow != null && dayLow > 0 ? { dayLow: String(dayLow) } : {}),
    ...(dayVolume != null && dayVolume >= 0 ? { dayVolume: String(dayVolume) } : {}),
    marketTimestamp,
    fetchedAt,
    freshness,
    provider: "cnbc_rest:fallback",
    session,
    priceType: session === "closed" ? "official_close" : ageSeconds <= 15 * 60 ? "last_trade" : "delayed_last",
    venueCode,
    validationStatus,
  };

  return {
    quote,
    ...(raw.shortName ? { shortName: raw.shortName } : {}),
    ...(raw.name ? { longName: raw.name } : {}),
    ...(raw.exchange ? { exchangeLabel: raw.exchange } : {}),
  };
}

export async function fetchCnbcQuote(
  symbol: string,
  securityId: string,
  venueCode: string,
  signal?: AbortSignal,
): Promise<{ quote: MarketQuote; shortName?: string; longName?: string; exchangeLabel?: string }> {
  const cnbcSymbol = mapYahooSymbolToCnbc(symbol);
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(cnbcSymbol)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": CNBC_USER_AGENT,
    },
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`CNBC returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as CnbcPayload;
  const quoteItem = payload.FormattedQuoteResult?.FormattedQuote?.[0];
  if (!quoteItem) {
    throw new Error(`CNBC returned no quote data for ${symbol}`);
  }

  const normalized = parseCnbcQuote(quoteItem, securityId, venueCode);
  if (!normalized) {
    throw new Error(`CNBC quote could not be parsed for ${symbol}`);
  }

  return normalized;
}

export async function fetchCnbcBatchQuotes(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, CnbcRawQuote>> {
  if (!symbols.length) return new Map();
  const symbolMap = new Map<string, string>(); // cnbcSymbol -> originalSymbol
  for (const sym of symbols) {
    const clean = sym.trim();
    if (clean) symbolMap.set(mapYahooSymbolToCnbc(clean), clean.toUpperCase());
  }
  const cnbcSymbols = [...symbolMap.keys()];
  if (!cnbcSymbols.length) return new Map();

  const results = new Map<string, CnbcRawQuote>();
  const chunkSize = 25;

  for (let i = 0; i < cnbcSymbols.length; i += chunkSize) {
    const chunk = cnbcSymbols.slice(i, i + chunkSize);
    try {
      const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(chunk.join("|"))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "User-Agent": CNBC_USER_AGENT,
        },
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) continue;

      const payload = (await response.json()) as CnbcPayload;
      const rawList = payload.FormattedQuoteResult?.FormattedQuote ?? [];

      for (const item of rawList) {
        if (!item.symbol) continue;
        const orig = symbolMap.get(item.symbol.toUpperCase()) ?? item.symbol.toUpperCase();
        results.set(orig, item);
      }
    } catch {
      // Chunk level catch: allow remaining chunks to proceed
    }
  }

  return results;
}
