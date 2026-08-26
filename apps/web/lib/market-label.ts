type MarketLabelInput = {
  exchangeMic?: string | null;
  exchangeName?: string | null;
  exchangeLabel?: string | null;
  quote?: { exchangeLabel?: string | null } | null;
};

const normalized = (value: string | null | undefined) => (value ?? "").normalize("NFKC").trim().toUpperCase();

export function marketDisplayName(security: MarketLabelInput) {
  const mic = normalized(security.exchangeMic);
  const source = normalized(security.quote?.exchangeLabel ?? security.exchangeLabel ?? security.exchangeName);

  if (mic === "JPFD" || mic === "XFND" || /投資信託|MUTUAL\s+FUND/u.test(source)) return "投資信託";
  if (mic === "XIND" || /株価指数|MARKET\s+INDEX/u.test(source)) return "株価指数";

  if (mic === "XTKS" || /東証|TOKYO|JPX/u.test(source)) {
    if (/PRM|プライム/u.test(source)) return "東証P";
    if (/GRT|グロース/u.test(source)) return "東証G";
    if (/STD|スタンダード/u.test(source)) return "東証S";
    if (/REIT/u.test(source)) return "東証REIT";
    if (/ETF|ETN/u.test(source)) return "東証ETF";
    if (/PRO/u.test(source)) return "TOKYO PRO";
    return "東証";
  }

  if (mic === "XNAS" || /NASDAQ|\bNMS\b|\bNGM\b|\bNCM\b/u.test(source)) return "NASDAQ";
  if (mic === "XNYS" || /NYSE(?!\s+ARCA|\s+AMERICAN)/u.test(source)) return "NYSE";
  if (mic === "ARCX" || /NYSE\s+ARCA|\bPCX\b/u.test(source)) return "NYSE Arca";
  if (mic === "XASE" || /NYSE\s+AMERICAN|AMEX/u.test(source)) return "NYSE American";
  if (mic === "BATS" || /CBOE\s+BZX|\bBATS\b/u.test(source)) return "Cboe BZX";
  if (mic === "OTCM" || /OTC\s+MARKETS|\bOTC\b/u.test(source)) return "OTC Markets";
  if (mic === "IEXG" || /\bIEX\b/u.test(source)) return "IEX";

  // Global Major Exchanges
  if (mic === "XLON" || /LONDON|\bLSE\b/u.test(source)) return "ロンドン (LSE)";
  if (mic === "XKRX" || /KOREA|KOSPI|KOSDAQ|\bKRX\b/u.test(source)) return "韓国 (KRX)";
  if (mic === "XETR" || mic === "XFRA" || /XETRA|FRANKFURT|GERMAN/u.test(source)) return "ドイツ (XETRA)";
  if (mic === "XHKG" || /HONG\s*KONG|\bHKEX\b/u.test(source)) return "香港 (HKEX)";
  if (mic === "XTSE" || mic === "XTSX" || /TORONTO|\bTSX\b/u.test(source)) return "トロント (TSX)";
  if (mic === "XASX" || /AUSTRALIAN|\bASX\b/u.test(source)) return "豪州 (ASX)";
  if (mic === "XPAR" || /PARIS|EURONEXT/u.test(source)) return "パリ (Euronext)";
  if (mic === "XAMS" || /AMSTERDAM/u.test(source)) return "アムステルダム";
  if (mic === "XSWX" || /SWISS|\bSIX\b/u.test(source)) return "スイス (SIX)";
  if (mic === "XTAI" || /TAIWAN|\bTWSE\b|\bTPEX\b/u.test(source)) return "台湾 (TWSE)";
  if (mic === "XSES" || /SINGAPORE|\bSGX\b/u.test(source)) return "シンガポール";
  if (mic === "XNSE" || mic === "XBOM" || /INDIA|\bNSE\b|\bBSE\b/u.test(source)) return "インド (NSE)";

  return security.exchangeLabel?.trim() || security.exchangeName?.trim() || security.exchangeMic?.trim() || "市場不明";
}
