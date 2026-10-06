import { searchKnownJapanFunds } from "../market/japan-fund-catalog";
import { globalSecurityId, yahooIndexSecurityId } from "../market/market-security";
import { searchEmbeddedCatalog } from "../market/stock-catalog";
import type { SearchResultSecurity } from "../market/market-wire";
import { USER_AGENT } from "./market-upstream";

/** Security search: embedded catalogs first, then Yahoo (global) and Yahoo! ファイナンス (Japanese names). Queries are never stored. */

type YahooSearchQuote = { symbol?: string; shortname?: string; longname?: string; exchange?: string; exchDisp?: string; quoteType?: string };
type Venue = { mic: string; label: string; country: string; currency: string; timezone: string; codes: string[]; suffixes: string[]; names: string[] };

const venue = (mic: string, label: string, country: string, currency: string, timezone: string, codes: string[], suffixes: string[] = [], names: string[] = []): Venue =>
  ({ mic, label, country, currency, timezone, codes, suffixes, names });

const US = "America/New_York";
const VENUES: Venue[] = [
  venue("XNAS", "NASDAQ", "US", "USD", US, ["NMS", "NGM", "NCM", "NAS", "NASDAQ", "XNAS"], [], ["NASDAQ"]),
  venue("ARCX", "NYSE Arca", "US", "USD", US, ["PCX", "ARCX", "NYSEARCA"], [], ["ARCA"]),
  venue("XASE", "NYSE American", "US", "USD", US, ["ASE", "XASE", "AMEX", "NYSEAMERICAN"], [], ["AMERICAN"]),
  venue("XNYS", "NYSE", "US", "USD", US, ["NYQ", "NYS", "NYSE", "XNYS"], [], ["NYSE"]),
  venue("BATS", "Cboe BZX", "US", "USD", US, ["BTS", "BATS", "CBOE", "CBOEBZX"], [], ["BATS", "CBOE"]),
  venue("OTCM", "OTC Markets", "US", "USD", US, ["PNK", "OTC", "OTCM", "OQX", "OQB", "OEM", "GREY"], [], ["OTC"]),
  venue("XLON", "ロンドン (LSE)", "GB", "GBP", "Europe/London", ["LSE", "LON", "XLON", "IOB"], [".L", ".IL"], ["LONDON"]),
  venue("XKRX", "韓国 (KRX)", "KR", "KRW", "Asia/Seoul", ["KSC", "KOE", "XKRX", "KSE", "KOSDAQ", "KDQ"], [".KS", ".KQ"], ["KOREA", "KOSPI", "KOSDAQ"]),
  venue("XETR", "ドイツ (XETRA)", "DE", "EUR", "Europe/Berlin", ["GER", "FRA", "XETRA", "XETR", "STU", "BER", "DUS", "HAM", "MUN"], [".DE", ".F"], ["XETRA", "FRANKFURT"]),
  venue("XHKG", "香港 (HKEX)", "HK", "HKD", "Asia/Hong_Kong", ["HKG", "HKSE", "XHKG"], [".HK"], ["HONG KONG"]),
  venue("XTSE", "トロント (TSX)", "CA", "CAD", "America/Toronto", ["TOR", "TSX", "XTSE", "VAN", "TSXV", "XTSX", "CNQ"], [".TO", ".V"], ["TORONTO", "TSX"]),
  venue("XASX", "豪州 (ASX)", "AU", "AUD", "Australia/Sydney", ["ASX", "XASX"], [".AX"], ["AUSTRALIAN", "ASX"]),
  venue("XPAR", "パリ (Euronext)", "FR", "EUR", "Europe/Paris", ["PAR", "EPA", "XPAR"], [".PA"], ["PARIS"]),
  venue("XAMS", "アムステルダム", "NL", "EUR", "Europe/Amsterdam", ["AMS", "XAMS"], [".AS"], ["AMSTERDAM"]),
  venue("XSWX", "スイス (SIX)", "CH", "CHF", "Europe/Zurich", ["EBS", "VTX", "SIX", "XSWX"], [".SW"], ["SWISS"]),
  venue("XTAI", "台湾 (TWSE)", "TW", "TWD", "Asia/Taipei", ["TAI", "XTAI", "TWO", "ROCO"], [".TW", ".TWO"], ["TAIWAN"]),
  venue("XSES", "シンガポール (SGX)", "SG", "SGD", "Asia/Singapore", ["SES", "SGX", "XSES"], [".SI"], ["SINGAPORE"]),
  venue("XNSE", "インド (NSE)", "IN", "INR", "Asia/Kolkata", ["NSE", "BSE", "XNSE", "XBOM"], [".NS", ".BO"], ["NSE", "BOMBAY"]),
];

function resolveVenue(exchange = "", display = "", symbol = "") {
  const code = exchange.normalize("NFKC").toUpperCase().replaceAll(" ", "");
  const name = display.normalize("NFKC").toUpperCase();
  return VENUES.find((item) => item.codes.includes(code))
    ?? VENUES.find((item) => item.suffixes.some((suffix) => symbol.endsWith(suffix)))
    ?? VENUES.find((item) => item.names.some((part) => name.includes(part)) && !(item.mic === "XNYS" && /ARCA|AMERICAN/u.test(name)))
    ?? null;
}

const cleanJapaneseName = (name: string) => name.replace(/^\(株\)/u, "").replace(/\(株\)$/u, "");

export function normalizeYahooSearchQuote(quote: YahooSearchQuote): SearchResultSecurity | null {
  const symbol = (quote.symbol ?? "").normalize("NFKC").toUpperCase();
  const type = (quote.quoteType ?? "").toUpperCase();
  const name = quote.longname ?? quote.shortname ?? symbol;
  if (!symbol || !name) return null;
  const japan = /^([0-9]{4}|[0-9]{3}[A-Z])\.T$/u.exec(symbol);
  if (japan) {
    return {
      id: `sec-${japan[1].toLowerCase()}-xtks`, displaySymbol: japan[1], name: cleanJapaneseName(name), assetType: type === "ETF" ? "etf" : "stock",
      country: "JP", exchangeMic: "XTKS", exchangeLabel: "東証", currency: "JPY", timezone: "Asia/Tokyo", providerSymbols: { yahoo: symbol },
    };
  }
  if (type === "INDEX" || symbol.startsWith("^")) {
    if (!/^\^[A-Z0-9.-]{1,30}$/u.test(symbol)) return null;
    const japanese = symbol === "^N225" || symbol === "^TOPX";
    return {
      id: yahooIndexSecurityId(symbol), displaySymbol: symbol, name, assetType: "index", country: japanese ? "JP" : "US", exchangeMic: "XIND",
      exchangeLabel: "株価指数", currency: japanese ? "JPY" : "USD", timezone: japanese ? "Asia/Tokyo" : US, providerSymbols: { yahoo: symbol },
    };
  }
  if (!["EQUITY", "ETF", "MUTUALFUND"].includes(type) || !/^[A-Z0-9.-]{1,20}$/u.test(symbol)) return null;
  const place = resolveVenue(quote.exchange, quote.exchDisp, symbol);
  if (!place) return null;
  const assetType = type === "ETF" ? "etf" : type === "MUTUALFUND" ? "fund" : "stock";
  if (place.country === "US") {
    return {
      id: type === "MUTUALFUND" ? `sec-us-fund-${symbol.toLowerCase()}` : `sec-us-${symbol.toLowerCase()}-${place.mic.toLowerCase()}`,
      displaySymbol: symbol, name, assetType, country: "US", exchangeMic: type === "MUTUALFUND" ? "XFND" : place.mic, exchangeLabel: place.label,
      currency: "USD", timezone: US, providerSymbols: { yahoo: symbol },
    };
  }
  return {
    id: globalSecurityId(symbol, place.mic), displaySymbol: symbol.includes(".") ? symbol.split(".")[0] : symbol, name, assetType,
    country: place.country, exchangeMic: place.mic, exchangeLabel: place.label, currency: place.currency, timezone: place.timezone, providerSymbols: { yahoo: symbol },
  };
}

export function parseYahooJapanSearch(html: string): SearchResultSecurity[] {
  const results: SearchResultSecurity[] = [];
  for (const match of html.matchAll(/"detailLink":"https:\/\/finance\.yahoo\.co\.jp\/quote\/([0-9]{4}|[0-9]{3}[A-Z])\.T","code":"[^"]+","marketName":"([^"]+)","name":"([^"]+)"/gu)) {
    if (!match[2].startsWith("東証")) continue;
    results.push({
      id: `sec-${match[1].toLowerCase()}-xtks`, displaySymbol: match[1], name: cleanJapaneseName(match[3]), assetType: "stock", country: "JP",
      exchangeMic: "XTKS", exchangeLabel: match[2], currency: "JPY", timezone: "Asia/Tokyo", providerSymbols: { yahoo: `${match[1]}.T` },
    });
  }
  for (const match of html.matchAll(/"detailLink":"https:\/\/finance\.yahoo\.co\.jp\/quote\/([A-Za-z0-9]{8})","code":"([A-Za-z0-9]{8})","marketName":"投資信託","name":"((?:\\.|[^"\\])*)"/gu)) {
    let name: string;
    try { name = JSON.parse(`"${match[3]}"`) as string; } catch { continue; }
    const code = match[1].toUpperCase();
    results.push({
      id: `sec-jp-fund-${code.toLowerCase()}`, displaySymbol: code, name, assetType: "fund", country: "JP", exchangeMic: "JPFD",
      exchangeLabel: "投資信託", currency: "JPY", timezone: "Asia/Tokyo", priceUnit: "10000", providerSymbols: { yahoo: code },
    });
  }
  return results;
}

async function yahooGlobal(query: string, signal: AbortSignal) {
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v1/finance/search?${new URLSearchParams({ q: query, quotesCount: "15", newsCount: "0", listsCount: "0" })}`;
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal });
      if (!response.ok) continue;
      const payload = await response.json() as { quotes?: YahooSearchQuote[] };
      return (payload.quotes ?? []).flatMap((quote) => normalizeYahooSearchQuote(quote) ?? []);
    } catch { /* Next host. */ }
  }
  return [];
}

async function yahooJapan(query: string, signal: AbortSignal) {
  const response = await fetch(`https://finance.yahoo.co.jp/search/?${new URLSearchParams({ query })}`, { headers: { Accept: "text/html", "User-Agent": USER_AGENT }, signal });
  return response.ok ? parseYahooJapanSearch(await response.text()) : [];
}

const cache = new Map<string, { expiresAt: number; results: SearchResultSecurity[] }>();

/** Authenticated by the caller. Body: `{ q }`. */
export async function searchSecurities(request: Request) {
  const body = await request.json().catch(() => ({})) as { q?: unknown };
  const query = typeof body.q === "string" ? body.q.trim() : "";
  const headers = { "Cache-Control": "private, max-age=300" };
  if (!query || query.length > 96) return Response.json({ results: [] }, { headers });
  const key = query.toLocaleLowerCase("ja");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Response.json({ results: cached.results }, { headers });
  const local: SearchResultSecurity[] = [...searchKnownJapanFunds(query), ...searchEmbeddedCatalog(query)].map((item) => ({ ...item, providerSymbols: item.providerSymbols ?? {} }));
  let remote: SearchResultSecurity[] = [];
  if (local.length < 10) {
    const signal = AbortSignal.timeout(2_300);
    const japanese = /^[0-9]{3,4}[A-Za-z]?$/u.test(query) || /[^\u0000-\u007f]/u.test(query);
    const latin = /^[A-Za-z0-9.^ -]{1,31}$/u.test(query);
    const settled = await Promise.allSettled([
      japanese || !latin ? yahooJapan(query, signal) : Promise.resolve([]),
      latin || !japanese ? yahooGlobal(query, signal) : Promise.resolve([]),
    ]);
    remote = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }
  const results = [...new Map([...local, ...remote].map((item) => [item.id, item])).values()].slice(0, 15);
  if (results.length) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { expiresAt: Date.now() + 86_400_000, results });
  }
  return Response.json({ results }, { headers });
}
