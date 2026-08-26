import { describe, expect, it } from "vitest";
import { defaultCurrencyForPortfolioFilter, isFundOrIndexSecurity, portfolioFilterLabel, securityMatchesPortfolioFilter, shouldShowDailyFundTrend } from "./portfolio-filter";

describe("portfolio filtering", () => {
  const jpStock = { assetType: "stock", country: "JP", currency: "JPY", exchangeMic: "XTKS" };
  const usStock = { assetType: "stock", country: "US", currency: "USD", exchangeMic: "XNAS" };
  const jpFund = { assetType: "fund", country: "JP", currency: "JPY", exchangeMic: "JPFD" };
  const usIndex = { assetType: "index", country: "US", currency: "USD", exchangeMic: "XIND" };
  const usEtf = { assetType: "etf", country: "US", currency: "USD", exchangeMic: "ARCX" };

  it("maps filter types to expected default currencies", () => {
    expect(defaultCurrencyForPortfolioFilter("JP")).toBe("JPY");
    expect(defaultCurrencyForPortfolioFilter("US")).toBe("USD");
    expect(defaultCurrencyForPortfolioFilter("FUNDS_INDEXES")).toBe("JPY");
    expect(defaultCurrencyForPortfolioFilter("ALL")).toBeNull();
  });

  it("keeps country filters limited to individual stocks", () => {
    expect(securityMatchesPortfolioFilter(jpStock, "JP")).toBe(true);
    expect(securityMatchesPortfolioFilter(usStock, "US")).toBe(true);
    expect(securityMatchesPortfolioFilter(usStock, "JP")).toBe(false);
    expect(securityMatchesPortfolioFilter(jpFund, "JP")).toBe(false);
    expect(securityMatchesPortfolioFilter(usIndex, "US")).toBe(false);
  });

  it("groups funds, indexes, and ETFs without applying a country", () => {
    for (const security of [jpFund, usIndex, usEtf]) {
      expect(isFundOrIndexSecurity(security)).toBe(true);
      expect(securityMatchesPortfolioFilter(security, "FUNDS_INDEXES")).toBe(true);
    }
    expect(securityMatchesPortfolioFilter(jpStock, "FUNDS_INDEXES")).toBe(false);
    expect(securityMatchesPortfolioFilter(usStock, "FUNDS_INDEXES")).toBe(false);
  });

  it("keeps the all-assets view inclusive", () => {
    for (const security of [jpStock, usStock, jpFund, usIndex, usEtf]) {
      expect(securityMatchesPortfolioFilter(security, "ALL")).toBe(true);
    }
  });

  it("uses the daily trend only for mutual funds inside the funds and indexes filter", () => {
    expect(shouldShowDailyFundTrend(jpFund, "FUNDS_INDEXES")).toBe(true);
    expect(shouldShowDailyFundTrend(jpFund, "ALL")).toBe(false);
    expect(shouldShowDailyFundTrend(jpFund, "JP")).toBe(false);
    expect(shouldShowDailyFundTrend(jpFund, "US")).toBe(false);
    expect(shouldShowDailyFundTrend(usIndex, "FUNDS_INDEXES")).toBe(false);
    expect(shouldShowDailyFundTrend(usEtf, "FUNDS_INDEXES")).toBe(false);
    expect(shouldShowDailyFundTrend(jpStock, "JP")).toBe(false);
    expect(shouldShowDailyFundTrend(usStock, "US")).toBe(false);
  });
});

