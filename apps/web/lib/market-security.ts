export type RequestedSecurity = {
  id: string;
  displaySymbol: string;
  exchangeMic: string;
  currency: string;
  providerSymbol: string;
  venueCode: "TSE" | "US" | "FX" | "FUND" | "USD_FUND" | "INDEX" | "GLOBAL";
};

export function yahooIndexSecurityId(symbol: string) {
  const normalized = symbol.normalize("NFKC").toUpperCase();
  const encoded = [...normalized].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `sec-us-index-${encoded}`;
}

export function yahooIndexSymbolFromId(encoded: string) {
  if (encoded.length % 2 !== 0 || encoded.length > 64) return null;
  const symbol = encoded.match(/.{2}/gu)?.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join("") ?? "";
  return /^\^[A-Z0-9.-]{1,30}$/u.test(symbol) ? symbol : null;
}

export function globalSecurityId(providerSymbol: string, exchangeMic: string) {
  const normalized = providerSymbol.normalize("NFKC").toUpperCase();
  const encoded = [...normalized].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `sec-gl-${encoded}-${exchangeMic.toLowerCase()}`;
}

export function globalSymbolFromId(encoded: string) {
  if (encoded.length % 2 !== 0 || encoded.length > 80) return null;
  const symbol = encoded.match(/.{2}/gu)?.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join("") ?? "";
  return /^[A-Z0-9.-]{1,30}$/u.test(symbol) ? symbol : null;
}

function currencyForExchangeMic(exchangeMic: string): string {
  switch (exchangeMic) {
    case "XTKS":
    case "JPFD":
      return "JPY";
    case "XLON":
      return "GBP";
    case "XKRX":
      return "KRW";
    case "XETR":
    case "XFRA":
    case "XPAR":
    case "XAMS":
    case "XMIL":
    case "XMAD":
      return "EUR";
    case "XHKG":
      return "HKD";
    case "XTSE":
    case "XTSX":
      return "CAD";
    case "XASX":
      return "AUD";
    case "XSWX":
      return "CHF";
    case "XTAI":
      return "TWD";
    case "XSES":
      return "SGD";
    case "XNSE":
    case "XBOM":
      return "INR";
    default:
      return "USD";
  }
}

export function normalizeRequestedSecurity(securityId: string): RequestedSecurity | null {
  if (securityId === "sec-fx-usdjpy") {
    return { id: securityId, displaySymbol: "USD/JPY", exchangeMic: "XFX", currency: "JPY", providerSymbol: "JPY=X", venueCode: "FX" };
  }
  if (securityId === "sec-foreign-fund-21070062") {
    return { id: securityId, displaySymbol: "21070062", exchangeMic: "XFND", currency: "USD", providerSymbol: "0162", venueCode: "FUND" };
  }
  const usdFund = /^sec-us-fund-([a-z0-9.-]{1,14})$/iu.exec(securityId);
  if (usdFund) {
    const symbol = usdFund[1].toUpperCase();
    return { id: `sec-us-fund-${symbol.toLowerCase()}`, displaySymbol: symbol, exchangeMic: "XFND", currency: "USD", providerSymbol: symbol, venueCode: "USD_FUND" };
  }
  const usdIndex = /^sec-us-index-([0-9a-f]+)$/iu.exec(securityId);
  if (usdIndex) {
    const symbol = yahooIndexSymbolFromId(usdIndex[1].toLowerCase());
    if (!symbol) return null;
    return { id: yahooIndexSecurityId(symbol), displaySymbol: symbol, exchangeMic: "XIND", currency: "USD", providerSymbol: symbol, venueCode: "INDEX" };
  }
  const fund = /^sec-jp-fund-([a-z0-9]{8})$/iu.exec(securityId);
  if (fund) {
    const code = fund[1].toUpperCase();
    return { id: `sec-jp-fund-${code.toLowerCase()}`, displaySymbol: code, exchangeMic: "JPFD", currency: "JPY", providerSymbol: code, venueCode: "FUND" };
  }
  const japan = /^sec-([0-9]{4}|[0-9]{3}[a-z])-xtks$/iu.exec(securityId);
  if (japan) {
    const symbol = japan[1].toUpperCase();
    return { id: `sec-${symbol.toLowerCase()}-xtks`, displaySymbol: symbol, exchangeMic: "XTKS", currency: "JPY", providerSymbol: `${symbol}.T`, venueCode: "TSE" };
  }
  const us = /^sec-us-([a-z0-9.-]{1,14})-(xnas|xnys|arcx|xase|bats|otcm)$/iu.exec(securityId);
  if (us) {
    const symbol = us[1].toUpperCase();
    const exchangeMic = us[2].toUpperCase() as "XNAS" | "XNYS" | "ARCX" | "XASE" | "BATS" | "OTCM";
    return { id: `sec-us-${symbol.toLowerCase()}-${exchangeMic.toLowerCase()}`, displaySymbol: symbol, exchangeMic, currency: "USD", providerSymbol: symbol, venueCode: "US" };
  }
  const global = /^sec-gl-([0-9a-f]+)-([a-z0-9]{3,6})$/iu.exec(securityId);
  if (global) {
    const symbol = globalSymbolFromId(global[1].toLowerCase());
    if (!symbol) return null;
    const exchangeMic = global[2].toUpperCase();
    const displaySymbol = symbol.includes(".") ? symbol.split(".")[0] : symbol;
    const currency = currencyForExchangeMic(exchangeMic);
    return {
      id: globalSecurityId(symbol, exchangeMic),
      displaySymbol,
      exchangeMic,
      currency,
      providerSymbol: symbol,
      venueCode: "GLOBAL",
    };
  }
  return null;
}

export function normalizeRequestedSecurities(value: string | null, max = 25) {
  const unique = [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  return unique.slice(0, max).map(normalizeRequestedSecurity).filter((item): item is RequestedSecurity => Boolean(item));
}
