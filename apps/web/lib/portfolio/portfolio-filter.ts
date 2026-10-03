export type PortfolioFilter = "ALL" | "JP" | "US" | "FUNDS_INDEXES";

export type FilterableSecurity = {
  id?: string;
  assetType?: string;
  country?: string;
  currency?: string;
  exchangeMic?: string;
  exchangeLabel?: string;
};

export function isFundSecurity(security: FilterableSecurity | null | undefined, fallbackId?: string): boolean {
  if (security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND") return true;
  const id = security?.id ?? fallbackId ?? "";
  return /^sec-(?:jp|us|foreign)-fund-/iu.test(id);
}

export function isIndexSecurity(security: FilterableSecurity | null | undefined, fallbackId?: string): boolean {
  if (security?.assetType === "index" || security?.exchangeMic === "XIND") return true;
  const id = security?.id ?? fallbackId ?? "";
  return /^sec-us-index-/iu.test(id);
}

export function isEtfSecurity(security: FilterableSecurity | null | undefined): boolean {
  return security?.assetType === "etf" || (security?.exchangeLabel?.includes("ETF") ?? false);
}

export function isFundOrIndexSecurity(security: FilterableSecurity | null | undefined, fallbackId?: string): boolean {
  if (isFundSecurity(security, fallbackId) || isIndexSecurity(security, fallbackId) || isEtfSecurity(security)) return true;
  return security?.assetType === "fund"
    || security?.assetType === "index"
    || security?.assetType === "etf"
    || security?.exchangeMic === "JPFD"
    || security?.exchangeMic === "XFND"
    || security?.exchangeMic === "XIND";
}

export function isUsSecurity(security: FilterableSecurity | null | undefined, fallbackId?: string): boolean {
  if (security?.country === "US" || security?.currency === "USD") return true;
  const id = security?.id ?? fallbackId ?? "";
  return /^sec-us-/iu.test(id);
}

export function isJpSecurity(security: FilterableSecurity | null | undefined, fallbackId?: string): boolean {
  if (security?.country === "JP" || security?.currency === "JPY") return true;
  const id = security?.id ?? fallbackId ?? "";
  return /^sec-(?:[0-9]{4}|[0-9]{3}[a-z])/iu.test(id);
}

export function securityAssetLabel(security: FilterableSecurity | null | undefined, fallbackId?: string): string {
  if (isFundSecurity(security, fallbackId)) return "投資信託";
  if (isIndexSecurity(security, fallbackId)) return "指数";
  if (isEtfSecurity(security)) return "ETF";
  if (isUsSecurity(security, fallbackId)) return "米国株";
  return "日本株";
}

export function securityMatchesPortfolioFilter(security: FilterableSecurity | null | undefined, filter: PortfolioFilter, fallbackId?: string): boolean {
  if (filter === "ALL") return true;
  if (filter === "FUNDS_INDEXES") return isFundOrIndexSecurity(security, fallbackId);
  if (isFundOrIndexSecurity(security, fallbackId)) return false;
  const country = security?.country ?? (security?.currency === "USD" || isUsSecurity(security, fallbackId) ? "US" : "JP");
  return country === filter;
}

export function shouldShowDailyFundTrend(security: FilterableSecurity | null | undefined, filter: PortfolioFilter) {
  return filter === "FUNDS_INDEXES"
    && (security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND");
}

export function portfolioFilterLabel(filter: PortfolioFilter) {
  if (filter === "JP") return "日本株";
  if (filter === "US") return "米国株";
  if (filter === "FUNDS_INDEXES") return "投信・指数";
  return "全資産";
}
