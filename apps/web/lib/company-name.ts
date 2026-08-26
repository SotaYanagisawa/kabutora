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
