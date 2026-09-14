import { describe, expect, it } from "vitest";
import {
  isEtfSecurity,
  isFundOrIndexSecurity,
  isFundSecurity,
  isIndexSecurity,
  isJpSecurity,
  isUsSecurity,
  portfolioFilterLabel,
  securityAssetLabel,
  securityMatchesPortfolioFilter,
  shouldShowDailyFundTrend,
} from "./portfolio-filter";

describe("portfolio filtering", () => {
  const jpStock = { id: "sec-7203", assetType: "stock", country: "JP", currency: "JPY", exchangeMic: "XTKS" };
  const usStock = { id: "sec-us-aapl", assetType: "stock", country: "US", currency: "USD", exchangeMic: "XNAS" };
  const jpFund = { id: "sec-jp-fund-0331418a", assetType: "fund", country: "JP", currency: "JPY", exchangeMic: "JPFD" };
  const usIndex = { id: "sec-us-index-gspc", assetType: "index", country: "US", currency: "USD", exchangeMic: "XIND" };
  const usEtf = { id: "sec-us-vym", assetType: "etf", country: "US", currency: "USD", exchangeMic: "ARCX" };

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

  it("identifies asset labels correctly", () => {
    expect(securityAssetLabel(jpStock)).toBe("日本株");
    expect(securityAssetLabel(usStock)).toBe("米国株");
    expect(securityAssetLabel(jpFund)).toBe("投資信託");
    expect(securityAssetLabel(usIndex)).toBe("指数");
    expect(securityAssetLabel(usEtf)).toBe("ETF");
  });

  it("supports fallback identification via security ID string when object is partial or undefined", () => {
    expect(isFundSecurity(undefined, "sec-jp-fund-0331418a")).toBe(true);
    expect(isFundSecurity(undefined, "sec-foreign-fund-21070062")).toBe(true);
    expect(isIndexSecurity(undefined, "sec-us-index-gspc")).toBe(true);
    expect(isUsSecurity(undefined, "sec-us-aapl")).toBe(true);
    expect(isJpSecurity(undefined, "sec-7203")).toBe(true);
    expect(securityAssetLabel(undefined, "sec-jp-fund-0331418a")).toBe("投資信託");
    expect(securityAssetLabel(undefined, "sec-us-aapl")).toBe("米国株");
    expect(securityAssetLabel(undefined, "sec-7203")).toBe("日本株");
    expect(securityMatchesPortfolioFilter(undefined, "FUNDS_INDEXES", "sec-jp-fund-0331418a")).toBe(true);
    expect(securityMatchesPortfolioFilter(undefined, "US", "sec-us-aapl")).toBe(true);
    expect(securityMatchesPortfolioFilter(undefined, "JP", "sec-7203")).toBe(true);
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

describe("page preferences storage keys and isolation", () => {
  it("defines distinct storage keys for summary and dividend preferences", async () => {
    const {
      SUMMARY_MARKET_FILTER_KEY,
      LEGACY_MARKET_FILTER_KEY,
      SUMMARY_BROKER_FILTER_KEY,
      SUMMARY_RANGE_KEY,
      SUMMARY_CUSTOM_RANGE_KEY,
      DIVIDEND_MARKET_FILTER_KEY,
      DIVIDEND_DISPLAY_CURRENCY_KEY,
      DIVIDEND_PERIOD_KEY,
      DIVIDEND_TAX_MODE_KEY,
      DIVIDEND_TAB_KEY,
      SUMMARY_AMOUNTS_VISIBLE_KEY,
    } = await import("../components/dashboard/constants");

    const summaryKeys = [
      SUMMARY_MARKET_FILTER_KEY,
      SUMMARY_BROKER_FILTER_KEY,
      SUMMARY_RANGE_KEY,
      SUMMARY_CUSTOM_RANGE_KEY,
      SUMMARY_AMOUNTS_VISIBLE_KEY,
    ];
    const dividendKeys = [
      DIVIDEND_MARKET_FILTER_KEY,
      DIVIDEND_DISPLAY_CURRENCY_KEY,
      DIVIDEND_PERIOD_KEY,
      DIVIDEND_TAX_MODE_KEY,
      DIVIDEND_TAB_KEY,
    ];

    expect(SUMMARY_MARKET_FILTER_KEY).toBe("kabutora-summary-market-filter");
    expect(DIVIDEND_MARKET_FILTER_KEY).toBe("kabutora-dividend-market-filter");
    expect(DIVIDEND_DISPLAY_CURRENCY_KEY).toBe("kabutora-dividend-display-currency");
    expect(LEGACY_MARKET_FILTER_KEY).toBe("kabutora-market-filter");

    const allKeys = [...summaryKeys, ...dividendKeys];
    const uniqueKeys = new Set(allKeys);
    expect(uniqueKeys.size).toBe(allKeys.length);
  });

  it("ensures summary filter does not overwrite dividend filter in storage map", async () => {
    const {
      SUMMARY_MARKET_FILTER_KEY,
      DIVIDEND_MARKET_FILTER_KEY,
      DIVIDEND_DISPLAY_CURRENCY_KEY,
      DIVIDEND_PERIOD_KEY,
      DIVIDEND_TAX_MODE_KEY,
      DIVIDEND_TAB_KEY,
    } = await import("../components/dashboard/constants");

    const storage = new Map<string, string>();
    storage.set(SUMMARY_MARKET_FILTER_KEY, "JP");
    storage.set("kabutora-display-currency", "JPY");
    storage.set(DIVIDEND_MARKET_FILTER_KEY, "US");
    storage.set(DIVIDEND_DISPLAY_CURRENCY_KEY, "USD");
    storage.set(DIVIDEND_PERIOD_KEY, "2025");
    storage.set(DIVIDEND_TAX_MODE_KEY, "net");
    storage.set(DIVIDEND_TAB_KEY, "history");

    expect(storage.get(SUMMARY_MARKET_FILTER_KEY)).toBe("JP");
    expect(storage.get("kabutora-display-currency")).toBe("JPY");
    expect(storage.get(DIVIDEND_MARKET_FILTER_KEY)).toBe("US");
    expect(storage.get(DIVIDEND_DISPLAY_CURRENCY_KEY)).toBe("USD");
    expect(storage.get(DIVIDEND_PERIOD_KEY)).toBe("2025");
    expect(storage.get(DIVIDEND_TAX_MODE_KEY)).toBe("net");
    expect(storage.get(DIVIDEND_TAB_KEY)).toBe("history");
  });
});
