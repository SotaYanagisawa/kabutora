type CompanyNameInput = {
  name: string;
  brandName?: string | null;
  shortName?: string | null;
  longName?: string | null;
  country?: string | null;
  exchangeMic?: string | null;
};

const US_EXCHANGES = new Set(["XNAS", "XNYS", "ARCX"]);
const LEGAL_SUFFIX = /(?:,?\s+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\.p|lp|p\.l\.c|plc))\.?$/iu;

function cleanName(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function withoutLegalSuffix(value: string) {
  let result = value;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(LEGAL_SUFFIX, "").trim();
  }
  return result || value;
}

/**
 * Prefer the market-data provider's published short name. The fallback only
 * removes generic legal suffixes; it never invents a company-specific alias.
 */
export function companyDisplayName(input: CompanyNameInput) {
  const storedName = cleanName(input.name);
  const isUsSecurity = input.country?.toUpperCase() === "US" || US_EXCHANGES.has(input.exchangeMic?.toUpperCase() ?? "");
  if (!isUsSecurity) return storedName;

  const providerShortName = cleanName(input.shortName);
  const providerLongName = cleanName(input.longName);
  const verifiedBrandName = cleanName(input.brandName);
  return withoutLegalSuffix(verifiedBrandName || providerShortName || providerLongName || storedName);
}

export function companyLegalName(input: CompanyNameInput) {
  return cleanName(input.longName) || cleanName(input.name);
}

/**
 * Shortens/abbreviates Japanese company and fund names for compact widget displays.
 * e.g. "キオクシアホールディングス" -> "キオクシア"
 * e.g. "リクルートホールディングス" -> "リクルート"
 * e.g. "三菱UFJフィナンシャル・グループ" -> "三菱UFJ"
 * e.g. "eMAXIS Slim 全世界株式（オール・カントリー）" -> "eMAXIS Slim 全世界株式"
 */
export function shortenJapaneseSecurityName(name: string, isFund = false): string {
  if (!name) return "";
  let s = cleanName(name);

  // Strip legal entity prefixes/suffixes (前株, 後株, etc.)
  s = s.replace(/\s*(?:株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\))\s*/gu, "");

  if (isFund) {
    // Strip promotional or trading prefixes like ＜購入・換金手数料なし＞
    s = s.replace(/^[＜<【\[][^＞>】\]]+[＞>】\]]\s*/u, "");
    s = s.replace(/^(?:つみたて|積立)\s*/u, "");
    // Normalize and strip duplicate parenthetical qualifiers
    s = s.replace(/\s*[（(](?:オール・カントリー|オルカン)[）)]/u, "");
    s = s.replace(/\s*[（(](?:S&P500|Ｓ＆Ｐ５００)[）)]/u, " S&P500");
    s = s.replace(/\s*・?インデックス・?ファンド$/u, "");
    s = s.replace(/\s*・?インデックス$/u, "");
    s = s.replace(/\s*・?オープン$/u, "");
    if (s.length > 8) {
      s = s.replace(/\s*・?ファンド$/u, "");
    }
    return s.trim();
  }

  // Japanese Stock corporate suffix shortening
  if (/ホールディングス$/u.test(s)) {
    const base = s.replace(/ホールディングス$/u, "").trim();
    s = base.length >= 3 ? base : `${base}HD`;
  } else if (/ホールディング$/u.test(s)) {
    const base = s.replace(/ホールディング$/u, "").trim();
    s = base.length >= 3 ? base : `${base}HD`;
  } else if (/・?フィナンシャル・?グループ$/u.test(s)) {
    const base = s.replace(/・?フィナンシャル・?グループ$/u, "").trim();
    s = base.includes("三菱UFJ") ? "三菱UFJ" : `${base}FG`;
  } else if (/フィナンシャルグループ$/u.test(s)) {
    const base = s.replace(/フィナンシャルグループ$/u, "").trim();
    s = `${base}FG`;
  } else if (/グループ$/u.test(s)) {
    const base = s.replace(/グループ$/u, "").trim();
    s = base.length >= 4 ? `${base}G` : base;
  }

  return s.trim();
}

/**
 * Returns the primary display title for widget cards:
 * - US stocks: ticker symbol (e.g. "AAPL", "NVDA")
 * - Japanese stocks & funds: abbreviated company / fund name (e.g. "キオクシア", "トヨタ自動車", "eMAXIS Slim 全世界株式")
 */
export function shortSecurityDisplayName({
  name,
  brandName,
  shortName,
  displaySymbol,
  isUs = false,
  isFund = false,
}: {
  name: string;
  brandName?: string | null;
  shortName?: string | null;
  displaySymbol?: string | null;
  isUs?: boolean;
  isFund?: boolean;
}): string {
  if (isUs) {
    return (displaySymbol || name).replace(/^sec-(?:us-|jp-)?/i, "").toUpperCase();
  }

  if (brandName && brandName.trim().length > 0 && brandName.trim().length <= 12) {
    return brandName.trim();
  }

  const raw = cleanName(shortName || brandName || name);
  return shortenJapaneseSecurityName(raw, isFund);
}
