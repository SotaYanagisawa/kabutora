import { companyDisplayName } from "./company-name";
import { globalSecurityId, yahooIndexSecurityId } from "./market-security";
import type { YahooUsdSearchQuote } from "./usd-security";

export type GlobalVenue = {
  mic: string;
  label: string;
  country: string;
  currency: string;
  timezone: string;
};

export function resolveGlobalVenue(exchangeCode?: string, exchDisp?: string, symbol?: string): GlobalVenue | null {
  const code = (exchangeCode ?? "").normalize("NFKC").toUpperCase().replaceAll(" ", "");
  const disp = (exchDisp ?? "").normalize("NFKC").toUpperCase();
  const sym = (symbol ?? "").toUpperCase();

  // US Exchanges
  if (["NMS", "NGM", "NCM", "NAS", "NASDAQ", "XNAS"].includes(code) || disp.includes("NASDAQ")) {
    return { mic: "XNAS", label: "NASDAQ", country: "US", currency: "USD", timezone: "America/New_York" };
  }
  if (["NYQ", "NYS", "NYSE", "XNYS"].includes(code) || (disp.includes("NYSE") && !disp.includes("ARCA") && !disp.includes("AMERICAN"))) {
    return { mic: "XNYS", label: "NYSE", country: "US", currency: "USD", timezone: "America/New_York" };
  }
  if (["PCX", "ARCX", "NYSEARCA"].includes(code) || disp.includes("ARCA")) {
    return { mic: "ARCX", label: "NYSE Arca", country: "US", currency: "USD", timezone: "America/New_York" };
  }
  if (["ASE", "XASE", "AMEX", "NYSEAMERICAN"].includes(code) || disp.includes("AMERICAN")) {
    return { mic: "XASE", label: "NYSE American", country: "US", currency: "USD", timezone: "America/New_York" };
  }
  if (["BTS", "BATS", "CBOE", "CBOEBZX"].includes(code) || disp.includes("BATS") || disp.includes("CBOE")) {
    return { mic: "BATS", label: "Cboe BZX", country: "US", currency: "USD", timezone: "America/New_York" };
  }
  if (["PNK", "OTC", "OTCM", "OQX", "OQB", "OEM", "GREY"].includes(code) || disp.includes("OTC")) {
    return { mic: "OTCM", label: "OTC Markets", country: "US", currency: "USD", timezone: "America/New_York" };
  }

  // Japan (Tokyo)
  if (["JPX", "TYO", "TSE", "XTKS"].includes(code) || disp.includes("TOKYO") || sym.endsWith(".T")) {
    return { mic: "XTKS", label: "東証", country: "JP", currency: "JPY", timezone: "Asia/Tokyo" };
  }

  // UK (London)
  if (["LSE", "LON", "XLON", "IOB"].includes(code) || disp.includes("LONDON") || sym.endsWith(".L") || sym.endsWith(".IL")) {
    return { mic: "XLON", label: "ロンドン (LSE)", country: "GB", currency: "GBP", timezone: "Europe/London" };
  }

  // Korea (KRX - KOSPI / KOSDAQ)
  if (["KSC", "KOE", "XKRX", "KSE", "KOSDAQ", "KDQ"].includes(code) || disp.includes("KOREA") || disp.includes("KOSPI") || disp.includes("KOSDAQ") || sym.endsWith(".KS") || sym.endsWith(".KQ")) {
    return { mic: "XKRX", label: "韓国 (KRX)", country: "KR", currency: "KRW", timezone: "Asia/Seoul" };
  }

  // Germany (XETRA / Frankfurt)
  if (["GER", "FRA", "XETRA", "XETR", "STU", "BER", "DUS", "HAM", "MUN"].includes(code) || disp.includes("XETRA") || disp.includes("FRANKFURT") || sym.endsWith(".DE") || sym.endsWith(".F")) {
    return { mic: "XETR", label: "ドイツ (XETRA)", country: "DE", currency: "EUR", timezone: "Europe/Berlin" };
  }

  // Hong Kong (HKEX)
  if (["HKG", "HKSE", "XHKG"].includes(code) || disp.includes("HONG KONG") || sym.endsWith(".HK")) {
    return { mic: "XHKG", label: "香港 (HKEX)", country: "HK", currency: "HKD", timezone: "Asia/Hong_Kong" };
  }

  // Canada (TSX / TSXV)
  if (["TOR", "TSX", "XTSE", "VAN", "TSXV", "XTSX", "CNQ"].includes(code) || disp.includes("TORONTO") || disp.includes("TSX") || sym.endsWith(".TO") || sym.endsWith(".V")) {
    return { mic: "XTSE", label: "トロント (TSX)", country: "CA", currency: "CAD", timezone: "America/Toronto" };
  }

  // Australia (ASX)
  if (["ASX", "XASX"].includes(code) || disp.includes("AUSTRALIAN") || disp.includes("ASX") || sym.endsWith(".AX")) {
    return { mic: "XASX", label: "豪州 (ASX)", country: "AU", currency: "AUD", timezone: "Australia/Sydney" };
  }

  // France (Euronext Paris)
  if (["PAR", "EPA", "XPAR"].includes(code) || disp.includes("PARIS") || sym.endsWith(".PA")) {
    return { mic: "XPAR", label: "パリ (Euronext)", country: "FR", currency: "EUR", timezone: "Europe/Paris" };
  }

  // Netherlands (Euronext Amsterdam)
  if (["AMS", "XAMS"].includes(code) || disp.includes("AMSTERDAM") || sym.endsWith(".AS")) {
    return { mic: "XAMS", label: "アムステルダム", country: "NL", currency: "EUR", timezone: "Europe/Amsterdam" };
  }

  // Switzerland (SIX Swiss Exchange)
  if (["EBS", "VTX", "SIX", "XSWX"].includes(code) || disp.includes("SWISS") || sym.endsWith(".SW")) {
    return { mic: "XSWX", label: "スイス (SIX)", country: "CH", currency: "CHF", timezone: "Europe/Zurich" };
  }

  // Taiwan (TWSE / TPEx)
  if (["TAI", "XTAI", "TWO", "ROCO"].includes(code) || disp.includes("TAIWAN") || sym.endsWith(".TW") || sym.endsWith(".TWO")) {
    return { mic: "XTAI", label: "台湾 (TWSE)", country: "TW", currency: "TWD", timezone: "Asia/Taipei" };
  }

  // Singapore (SGX)
  if (["SES", "SGX", "XSES"].includes(code) || disp.includes("SINGAPORE") || sym.endsWith(".SI")) {
    return { mic: "XSES", label: "シンガポール (SGX)", country: "SG", currency: "SGD", timezone: "Asia/Singapore" };
  }

  // India (NSE / BSE)
  if (["NSE", "BSE", "XNSE", "XBOM"].includes(code) || disp.includes("NSE") || disp.includes("BOMBAY") || sym.endsWith(".NS") || sym.endsWith(".BO")) {
    return { mic: "XNSE", label: "インド (NSE)", country: "IN", currency: "INR", timezone: "Asia/Kolkata" };
  }

  return null;
}

export function normalizeYahooGlobalQuote(quote: YahooUsdSearchQuote) {
  const providerSymbol = (quote.symbol ?? "").normalize("NFKC").toUpperCase();
  const quoteType = (quote.quoteType ?? "").toUpperCase();
  const sourceName = quote.longname ?? quote.shortname ?? providerSymbol;
  if (!providerSymbol || !sourceName) return null;

  // Japanese Stock from Global Search (.T)
  if (/^[0-9]{4}\.T$/u.test(providerSymbol) || /^[0-9]{3}[A-Z]\.T$/u.test(providerSymbol)) {
    const displaySymbol = providerSymbol.slice(0, -2);
    return {
      id: `sec-${displaySymbol.toLowerCase()}-xtks`,
      canonicalSymbol: providerSymbol,
      displaySymbol,
      providerSymbols: { yahoo: providerSymbol },
      name: sourceName.replace(/^\(株\)/u, "").replace(/\(株\)$/u, ""),
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: "stock" as const,
      country: "JP" as const,
      exchangeMic: "XTKS",
      exchangeName: "東京証券取引所",
      exchangeLabel: "東証",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      priceUnit: "1",
    };
  }

  // Indexes (^...)
  if (quoteType === "INDEX" || providerSymbol.startsWith("^")) {
    if (!/^\^[A-Z0-9.-]{1,30}$/u.test(providerSymbol)) return null;
    const isJapan = providerSymbol === "^N225" || providerSymbol === "^TOPX";
    const isUK = providerSymbol === "^FTSE";
    const isGermany = providerSymbol === "^GDAXI";
    const isHK = providerSymbol === "^HSI";
    const isKorea = providerSymbol === "^KS11" || providerSymbol === "^KQ11";
    const isFrance = providerSymbol === "^FCHI";
    const isAustralia = providerSymbol === "^AXJO";
    const isCanada = providerSymbol === "^GSPTSE";
    const isEurope = providerSymbol === "^STOXX50E";

    const country = isJapan ? "JP" : isUK ? "GB" : isGermany ? "DE" : isHK ? "HK" : isKorea ? "KR" : isFrance ? "FR" : isAustralia ? "AU" : isCanada ? "CA" : isEurope ? "EU" : "US";
    const timezone = isJapan ? "Asia/Tokyo" : isUK ? "Europe/London" : isGermany || isFrance || isEurope ? "Europe/Berlin" : isHK ? "Asia/Hong_Kong" : isKorea ? "Asia/Seoul" : isAustralia ? "Australia/Sydney" : isCanada ? "America/Toronto" : "America/New_York";
    const currency = isJapan ? "JPY" : isUK ? "GBP" : isGermany || isFrance || isEurope ? "EUR" : isHK ? "HKD" : isKorea ? "KRW" : isAustralia ? "AUD" : isCanada ? "CAD" : "USD";

    return {
      id: yahooIndexSecurityId(providerSymbol),
      canonicalSymbol: providerSymbol,
      displaySymbol: providerSymbol,
      providerSymbols: { yahoo: providerSymbol },
      name: sourceName,
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: "index" as const,
      country,
      exchangeMic: "XIND",
      exchangeName: quote.exchDisp || quote.exchange || "株価指数",
      exchangeLabel: "株価指数",
      currency,
      timezone,
      priceUnit: "1",
    };
  }

  // Mutual Funds
  if (quoteType === "MUTUALFUND") {
    const venue = resolveGlobalVenue(quote.exchange, quote.exchDisp, providerSymbol);
    if (!venue || !/^[A-Z0-9.-]{1,20}$/u.test(providerSymbol)) return null;
    return {
      id: venue.country === "US" ? `sec-us-fund-${providerSymbol.toLowerCase()}` : globalSecurityId(providerSymbol, venue.mic),
      canonicalSymbol: providerSymbol,
      displaySymbol: providerSymbol,
      providerSymbols: { yahoo: providerSymbol },
      name: sourceName,
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: "fund" as const,
      country: venue.country,
      exchangeMic: venue.mic,
      exchangeName: `${venue.label} 投資信託`,
      exchangeLabel: `${venue.label} 投信`,
      currency: venue.currency,
      timezone: venue.timezone,
      priceUnit: "1",
    };
  }

  // Equities and ETFs
  if (["EQUITY", "ETF"].includes(quoteType)) {
    const venue = resolveGlobalVenue(quote.exchange, quote.exchDisp, providerSymbol);
    if (!venue || !/^[A-Z0-9.-]{1,20}$/u.test(providerSymbol)) return null;

    // Format display symbol for international stocks (e.g. "005930" for "005930.KS", "VOD" for "VOD.L", "SAP" for "SAP.DE")
    const displaySymbol = providerSymbol.includes(".") ? providerSymbol.split(".")[0] : providerSymbol;
    const name = companyDisplayName({ name: sourceName, shortName: quote.shortname, longName: quote.longname, country: venue.country, exchangeMic: venue.mic });
    const id = venue.country === "US"
      ? `sec-us-${providerSymbol.toLowerCase()}-${venue.mic.toLowerCase()}`
      : globalSecurityId(providerSymbol, venue.mic);

    return {
      id,
      canonicalSymbol: providerSymbol,
      displaySymbol,
      providerSymbols: { yahoo: providerSymbol },
      name,
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: quoteType === "ETF" ? ("etf" as const) : ("stock" as const),
      country: venue.country,
      exchangeMic: venue.mic,
      exchangeName: venue.label,
      exchangeLabel: venue.label,
      currency: venue.currency,
      timezone: venue.timezone,
      priceUnit: "1",
    };
  }

  return null;
}
