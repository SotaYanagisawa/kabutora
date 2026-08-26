export type PortfolioFilter = "ALL" | "JP" | "US" | "FUNDS_INDEXES";

type FilterableSecurity = {
  assetType?: string;
  country?: string;
  currency?: string;
  exchangeMic?: string;
};

export function isFundOrIndexSecurity(security: FilterableSecurity | null | undefined) {
  return security?.assetType === "fund"
    || security?.assetType === "index"
    || security?.assetType === "etf"
    || security?.exchangeMic === "JPFD"
    || security?.exchangeMic === "XFND"
    || security?.exchangeMic === "XIND";
}

export function securityMatchesPortfolioFilter(security: FilterableSecurity, filter: PortfolioFilter) {
  if (filter === "ALL") return true;
  if (filter === "FUNDS_INDEXES") return isFundOrIndexSecurity(security);
  if (isFundOrIndexSecurity(security)) return false;
  const country = security.country ?? (security.currency === "USD" ? "US" : "JP");
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

export function defaultCurrencyForPortfolioFilter(filter: PortfolioFilter): "JPY" | "USD" | null {
  if (filter === "JP") return "JPY";
  if (filter === "US") return "USD";
  if (filter === "FUNDS_INDEXES") return "JPY";
  return null;
}

