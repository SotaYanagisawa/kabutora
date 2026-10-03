import { companyDisplayName } from "../../ui/company-name";
import { yahooIndexSecurityId } from "../../market/market-security";

export type YahooUsdSearchQuote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
};

type UsVenue = { mic: "XNAS" | "XNYS" | "ARCX" | "XASE" | "BATS" | "OTCM"; label: string };

function usVenue(value: string | undefined): UsVenue | null {
  const exchange = (value ?? "").normalize("NFKC").toUpperCase().replaceAll(" ", "");
  if (["NMS", "NGM", "NCM", "NAS", "NASDAQ", "XNAS"].includes(exchange)) return { mic: "XNAS", label: "NASDAQ" };
  if (["NYQ", "NYS", "NYSE", "XNYS"].includes(exchange)) return { mic: "XNYS", label: "NYSE" };
  if (["PCX", "ARCX", "NYSEARCA"].includes(exchange)) return { mic: "ARCX", label: "NYSE Arca" };
  if (["ASE", "XASE", "AMEX", "NYSEAMERICAN"].includes(exchange)) return { mic: "XASE", label: "NYSE American" };
  if (["BTS", "BATS", "CBOE", "CBOEBZX"].includes(exchange)) return { mic: "BATS", label: "Cboe BZX" };
  if (["PNK", "OTC", "OTCM", "OQX", "OQB", "OEM", "GREY"].includes(exchange)) return { mic: "OTCM", label: "OTC Markets" };
  return null;
}

const US_INDEX_EXCHANGES = new Set(["SNP", "DJI", "WCB", "NIM", "NAS", "CBOE", "CXI", "NYQ", "NYS", "ASE", "CBT"]);

export function normalizeYahooUsdQuote(quote: YahooUsdSearchQuote) {
  const providerSymbol = (quote.symbol ?? "").normalize("NFKC").toUpperCase();
  const quoteType = (quote.quoteType ?? "").toUpperCase();
  const sourceName = quote.longname ?? quote.shortname ?? providerSymbol;
  if (!providerSymbol || !sourceName) return null;

  if (quoteType === "MUTUALFUND") {
    const venue = usVenue(quote.exchange) ?? usVenue(quote.exchDisp);
    if (!venue || !/^[A-Z][A-Z0-9.-]{0,14}$/u.test(providerSymbol)) return null;
    return {
      id: `sec-us-fund-${providerSymbol.toLowerCase()}`,
      canonicalSymbol: providerSymbol,
      displaySymbol: providerSymbol,
      providerSymbols: { yahoo: providerSymbol },
      name: sourceName,
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: "fund" as const,
      country: "US" as const,
      exchangeMic: "XFND" as const,
      exchangeName: "米国投資信託",
      exchangeLabel: "米国投資信託",
      currency: "USD" as const,
      timezone: "America/New_York",
      priceUnit: "1" as const,
    };
  }

  if (quoteType === "INDEX") {
    const exchange = (quote.exchange ?? "").toUpperCase();
    if (!US_INDEX_EXCHANGES.has(exchange) || !/^\^[A-Z0-9.-]{1,30}$/u.test(providerSymbol)) return null;
    return {
      id: yahooIndexSecurityId(providerSymbol),
      canonicalSymbol: providerSymbol,
      displaySymbol: providerSymbol,
      providerSymbols: { yahoo: providerSymbol },
      name: sourceName,
      ...(quote.shortname ? { shortName: quote.shortname } : {}),
      ...(quote.longname ? { longName: quote.longname } : {}),
      assetType: "index" as const,
      country: "US" as const,
      exchangeMic: "XIND" as const,
      exchangeName: quote.exchDisp || quote.exchange || "米国株価指数",
      exchangeLabel: "米国株価指数",
      currency: "USD" as const,
      timezone: "America/New_York",
      priceUnit: "1" as const,
    };
  }

  if (!["EQUITY", "ETF"].includes(quoteType)) return null;
  const venue = usVenue(quote.exchange) ?? usVenue(quote.exchDisp);
  if (!venue || !/^[A-Z][A-Z0-9.-]{0,14}$/u.test(providerSymbol)) return null;
  const name = companyDisplayName({ name: sourceName, shortName: quote.shortname, longName: quote.longname, country: "US", exchangeMic: venue.mic });
  return {
    id: `sec-us-${providerSymbol.toLowerCase()}-${venue.mic.toLowerCase()}`,
    canonicalSymbol: providerSymbol,
    displaySymbol: providerSymbol,
    providerSymbols: { yahoo: providerSymbol },
    name,
    ...(quote.shortname ? { shortName: quote.shortname } : {}),
    ...(quote.longname ? { longName: quote.longname } : {}),
    assetType: quoteType === "ETF" ? "etf" as const : "stock" as const,
    country: "US" as const,
    exchangeMic: venue.mic,
    exchangeName: venue.label,
    exchangeLabel: venue.label,
    currency: "USD" as const,
    timezone: "America/New_York",
    priceUnit: "1" as const,
  };
}
