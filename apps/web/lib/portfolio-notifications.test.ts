import { describe, expect, it } from "vitest";
import { derivePortfolioNotifications, mergePortfolioNotifications, tseDailyPriceLimit } from "./portfolio-notifications";

const securities = [{
  id: "sec-a", displaySymbol: "A", name: "A社", exchangeMic: "XTKS", currency: "JPY",
  quote: {
    price: "150", previousRegularClose: "100", marketTimestamp: "2026-08-10T06:00:00Z", fetchedAt: "2026-08-10T06:01:00Z",
    freshness: "near_live" as const, provider: "fixture", session: "regular" as const, priceType: "last_trade" as const,
    venueCode: "TSE", validationStatus: "valid" as const,
  },
}];

describe("portfolio notifications", () => {
  it("uses the Tokyo Stock Exchange daily price bands", () => {
    expect(tseDailyPriceLimit(99)).toBe(30);
    expect(tseDailyPriceLimit(100)).toBe(50);
    expect(tseDailyPriceLimit(2_999)).toBe(500);
  });

  it("derives limit-up and split details without another market request", () => {
    const result = derivePortfolioNotifications({
      transactions: [{ id: "buy", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "1200", grossAmount: "12000" }],
      securities,
      actions: [{ id: "split", securityId: "sec-a", type: "SPLIT", effectiveDate: "2026-06-01", numerator: "3", denominator: "1", sourceProvider: "fixture" }],
      bars: [
        { securityId: "sec-a", date: "2026-05-29", close: "400", provider: "fixture" },
        { securityId: "sec-a", date: "2026-06-01", close: "400", provider: "fixture" },
      ],
    });
    expect(result.map((notice) => notice.type)).toEqual(["LIMIT_UP", "SPLIT"]);
    expect(result.find((notice) => notice.type === "SPLIT")).toMatchObject({
      portfolioImpact: "ADJUSTED",
      beforeQuantity: "10", afterQuantity: "30", beforeAverageCost: "1200", afterAverageCost: "400",
      beforeReferencePrice: "1200", afterReferencePrice: "400",
    });
  });

  it("keeps split events for previously traded securities and marks them as adjusted", () => {
    const result = derivePortfolioNotifications({
      transactions: [
        { id: "nippon-buy", accountId: "a", securityId: "sec-5401-xtks", type: "BUY", tradeDate: "2024-01-10", quantity: "100", pricePerShare: "3200", grossAmount: "320000" },
        { id: "nippon-sell", accountId: "a", securityId: "sec-5401-xtks", type: "SELL", tradeDate: "2025-01-10", quantity: "100", pricePerShare: "3300", grossAmount: "330000" },
        { id: "foodlife-buy", accountId: "a", securityId: "sec-3563-xtks", type: "BUY", tradeDate: "2026-01-10", quantity: "10", pricePerShare: "6000", grossAmount: "60000" },
      ],
      securities: [
        { id: "sec-5401-xtks", displaySymbol: "5401", name: "日本製鉄", exchangeMic: "XTKS", currency: "JPY" },
        { id: "sec-3563-xtks", displaySymbol: "3563", name: "FOOD & LIFE COMPANIES", exchangeMic: "XTKS", currency: "JPY" },
      ],
      actions: [
        { id: "nippon-split", securityId: "sec-5401-xtks", type: "SPLIT", effectiveDate: "2025-09-29", numerator: "5", denominator: "1", sourceProvider: "fixture" },
        { id: "foodlife-split", securityId: "sec-3563-xtks", type: "SPLIT", effectiveDate: "2026-06-29", numerator: "2", denominator: "1", sourceProvider: "fixture" },
      ],
      bars: [],
    });

    expect(result).toHaveLength(2);
    expect(result.find((notice) => notice.securityId === "sec-5401-xtks")).toMatchObject({
      type: "SPLIT", portfolioImpact: "ADJUSTED", title: "日本製鉄の株式分割",
      summary: "比率 1:5（保有残高・取引履歴を自動反映）",
    });
    expect(result.find((notice) => notice.securityId === "sec-5401-xtks")).not.toHaveProperty("beforeQuantity");
    expect(result.find((notice) => notice.securityId === "sec-3563-xtks")).toMatchObject({
      type: "SPLIT", portfolioImpact: "ADJUSTED", title: "FOOD & LIFE COMPANIESの株式分割",
      summary: "比率 1:2（保有残高・取引履歴を自動反映）",
      beforeQuantity: "10", afterQuantity: "20", beforeAverageCost: "6000", afterAverageCost: "3000",
    });
  });

  it("keeps TOB notices only for securities that appeared in the ledger", () => {
    const result = derivePortfolioNotifications({
      transactions: [{ id: "buy", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      securities: securities.map((security) => ({ ...security, quote: undefined })), actions: [], bars: [],
      externalNotices: [
        { id: "tob-a", securityId: "sec-a", type: "TOB", occurredAt: "2026-07-01", title: "A社へのTOB", summary: "公開買付を発表", source: "fixture", offerPrice: "150", currency: "JPY" },
        { id: "tob-b", securityId: "sec-b", type: "TOB", occurredAt: "2026-07-01", title: "B社へのTOB", summary: "公開買付を発表", source: "fixture" },
      ],
    });
    expect(result.map((notice) => notice.id)).toEqual(["tob-a"]);
  });

  it("creates price-move notifications for US holdings", () => {
    const result = derivePortfolioNotifications({
      transactions: [{ id: "buy-us", accountId: "a", securityId: "sec-us", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      securities: [{
        id: "sec-us", displaySymbol: "ACME", name: "Acme", exchangeMic: "XNAS", currency: "USD",
        quote: {
          price: "106", previousRegularClose: "100", marketTimestamp: "2026-08-10T20:00:00Z", fetchedAt: "2026-08-10T20:01:00Z",
          freshness: "near_live", provider: "fixture", session: "regular", priceType: "last_trade", venueCode: "US", validationStatus: "valid",
        },
      }],
      actions: [], bars: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "PRICE_UP", securityId: "sec-us" });
    expect(Number(result[0].changeRatio)).toBeCloseTo(0.06);
  });

  it("backfills every qualifying historical US move and merges it with retained history", () => {
    const derived = derivePortfolioNotifications({
      transactions: [{ id: "buy-us", accountId: "a", securityId: "sec-us", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      securities: [{ id: "sec-us", displaySymbol: "ACME", name: "Acme", exchangeMic: "XNAS", currency: "USD" }],
      actions: [],
      bars: [
        { securityId: "sec-us", date: "2026-01-02", close: "100", adjustedClose: "100", provider: "fixture" },
        { securityId: "sec-us", date: "2026-01-03", close: "106", adjustedClose: "106", provider: "fixture" },
        { securityId: "sec-us", date: "2026-01-04", close: "99", adjustedClose: "99", provider: "fixture" },
      ],
    });
    expect(derived.map((notice) => notice.type)).toEqual(["PRICE_DOWN", "PRICE_UP"]);
    const retained = { ...derived[1], id: "retained", occurredAt: "2025-12-01" };
    expect(mergePortfolioNotifications([retained], derived).map((notice) => notice.id)).toEqual([
      derived[0].id, derived[1].id, "retained",
    ]);
  });

  it("respects custom price move threshold", () => {
    const params = {
      transactions: [{ id: "buy-us", accountId: "a", securityId: "sec-us", type: "BUY" as const, tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      securities: [{
        id: "sec-us", displaySymbol: "ACME", name: "Acme", exchangeMic: "XNAS", currency: "USD",
        quote: {
          price: "106", previousRegularClose: "100", marketTimestamp: "2026-08-10T20:00:00Z", fetchedAt: "2026-08-10T20:01:00Z",
          freshness: "near_live" as const, provider: "fixture", session: "regular" as const, priceType: "last_trade" as const, venueCode: "US", validationStatus: "valid" as const,
        },
      }],
      actions: [], bars: [],
    };

    // 6% change with 7% threshold -> no notification
    const strictResult = derivePortfolioNotifications({ ...params, priceMoveThreshold: 0.07 });
    expect(strictResult).toHaveLength(0);

    // 6% change with 4% threshold -> triggers PRICE_UP notification
    const sensitiveResult = derivePortfolioNotifications({ ...params, priceMoveThreshold: 0.04 });
    expect(sensitiveResult).toHaveLength(1);
    expect(sensitiveResult[0]).toMatchObject({ type: "PRICE_UP", securityId: "sec-us" });
  });

  it("calculates exact unadjusted reference prices across multi-stage consecutive stock splits", () => {
    const multiSplitSecurities = [
      { id: "sec-multi", displaySymbol: "MULTI", name: "Multi Split Corp", exchangeMic: "XNYS", currency: "USD" },
    ];
    const actions = [
      { id: "split-1", securityId: "sec-multi", type: "SPLIT" as const, effectiveDate: "2024-06-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
      { id: "split-2", securityId: "sec-multi", type: "SPLIT" as const, effectiveDate: "2025-06-01", numerator: "3", denominator: "1", sourceProvider: "fixture" },
    ];
    // In provider data, bar before split 1 has been adjusted by 2 * 3 = 6x ($100). Bar between split 1 & 2 is adjusted by 3x ($100). Bar after split 2 is $100.
    const bars = [
      { securityId: "sec-multi", date: "2024-05-31", close: "100", provider: "fixture" },
      { securityId: "sec-multi", date: "2024-06-03", close: "100", provider: "fixture" },
      { securityId: "sec-multi", date: "2025-05-30", close: "100", provider: "fixture" },
      { securityId: "sec-multi", date: "2025-06-02", close: "100", provider: "fixture" },
    ];
    const transactions = [
      { id: "buy-early", accountId: "a", securityId: "sec-multi", type: "BUY" as const, tradeDate: "2024-01-10", quantity: "10", pricePerShare: "600", grossAmount: "6000" },
    ];

    const result = derivePortfolioNotifications({
      transactions,
      securities: multiSplitSecurities,
      actions,
      bars,
    });

    const split1Notice = result.find((n) => n.id === "notice:split-1");
    const split2Notice = result.find((n) => n.id === "notice:split-2");

    expect(split1Notice).toBeDefined();
    expect(split2Notice).toBeDefined();

    // Split 1 (2:1): Unadjusted pre-split price was $100 * (2 * 3) = $600. Post-split price was $100 * 3 = $300.
    expect(split1Notice).toMatchObject({
      type: "SPLIT",
      beforeReferencePrice: "600",
      afterReferencePrice: "300",
      beforeQuantity: "10",
      afterQuantity: "20",
    });

    // Split 2 (3:1): Pre-split price was $100 * 3 = $300. Post-split price was $100.
    expect(split2Notice).toMatchObject({
      type: "SPLIT",
      beforeReferencePrice: "300",
      afterReferencePrice: "100",
      beforeQuantity: "20",
      afterQuantity: "60",
    });
  });

  it("handles reverse splits with inverse multiplier and correct naming", () => {
    const reverseSecurities = [
      { id: "sec-rev", displaySymbol: "REV", name: "Reverse Corp", exchangeMic: "XTKS", currency: "JPY" },
    ];
    const actions = [
      { id: "rev-split", securityId: "sec-rev", type: "REVERSE_SPLIT" as const, effectiveDate: "2026-06-01", numerator: "1", denominator: "10", sourceProvider: "fixture" },
    ];
    const bars = [
      { securityId: "sec-rev", date: "2026-05-30", close: "1000", provider: "fixture" },
      { securityId: "sec-rev", date: "2026-06-01", close: "1000", provider: "fixture" },
    ];
    const transactions = [
      { id: "buy-rev", accountId: "a", securityId: "sec-rev", type: "BUY" as const, tradeDate: "2026-01-10", quantity: "100", pricePerShare: "100", grossAmount: "10000" },
    ];

    const result = derivePortfolioNotifications({
      transactions,
      securities: reverseSecurities,
      actions,
      bars,
    });

    const revNotice = result.find((n) => n.id === "notice:rev-split");
    expect(revNotice).toMatchObject({
      type: "REVERSE_SPLIT",
      title: "Reverse Corpの株式併合",
      beforeQuantity: "100",
      afterQuantity: "10",
      beforeAverageCost: "100",
      afterAverageCost: "1000",
      beforeReferencePrice: "100",
      afterReferencePrice: "1000",
    });
  });

  it("suppresses false live price spike/drop alerts on split ex-dates", () => {
    const securitiesWithLive = [{
      id: "sec-live-split", displaySymbol: "LIVESPLIT", name: "Live Split Co", exchangeMic: "XNAS", currency: "USD",
      quote: {
        price: "100", previousRegularClose: "200", marketTimestamp: "2026-06-01T14:30:00Z", fetchedAt: "2026-06-01T14:30:00Z",
        freshness: "live" as const, provider: "fixture", session: "regular" as const, priceType: "last_trade" as const, venueCode: "US", validationStatus: "valid" as const,
      },
    }];
    const actions = [
      { id: "live-split-act", securityId: "sec-live-split", type: "SPLIT" as const, effectiveDate: "2026-06-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
    ];
    const transactions = [
      { id: "buy-live", accountId: "a", securityId: "sec-live-split", type: "BUY" as const, tradeDate: "2026-01-10", quantity: "10", pricePerShare: "200", grossAmount: "2000" },
    ];

    const result = derivePortfolioNotifications({
      transactions,
      securities: securitiesWithLive,
      actions,
      bars: [],
    });

    // Should include the SPLIT notice, but NO false PRICE_DOWN (-50%) alert
    expect(result.map((n) => n.type)).toEqual(["SPLIT"]);
  });
});

