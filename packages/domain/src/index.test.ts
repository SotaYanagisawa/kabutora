import { describe, expect, it } from "vitest";
import {
  applySplit,
  calculateAverageCostPortfolio,
  calculateDividendIncome,
  canonicalDomainSecurityId,
  deriveSplitAdjustedTransactions,
  deriveTransactionPositionSnapshots,
  domainSecurityIdVariants,
  matchSecurityId,
  reconstructPortfolioHistory,
  reconstructSecurityHistory,
  type CorporateAction,
  type DistributionEvent,
  type LedgerTransaction,
  type MarketBar,
  type SecurityQuote,
} from "./index";


const security: SecurityQuote = {
  id: "sec-a",
  displaySymbol: "A",
  name: "A Corp",
  exchangeMic: "XTKS",
  quote: {
    price: "150",
    previousRegularClose: "140",
    marketTimestamp: "2026-08-07T06:30:00Z",
    fetchedAt: "2026-08-07T06:31:00Z",
    freshness: "cached",
    provider: "fixture",
    session: "closed",
    priceType: "official_close",
    venueCode: "TSE",
    validationStatus: "valid",
  },
};

describe("average cost portfolio", () => {
  it("values Japanese mutual-fund NAVs quoted per 10,000 units", () => {
    const fund: SecurityQuote = {
      id: "sec-jp-fund-02314143",
      displaySymbol: "02314143",
      name: "Index Fund",
      exchangeMic: "JPFD",
      priceUnit: "10000",
      quote: { ...security.quote!, price: "20000", previousRegularClose: "19500", venueCode: "FUND" },
    };
    const result = calculateAverageCostPortfolio([
      { id: "fund-buy", accountId: "a", securityId: fund.id, type: "BUY", tradeDate: "2026-01-02", quantity: "25000", pricePerShare: "16000", grossAmount: null },
    ], [fund]);
    expect(result.holdings[0]).toMatchObject({
      quantity: "25000",
      totalCost: "40000",
      averageCost: "16000",
      currentPrice: "20000",
      marketValue: "50000",
      unrealizedGain: "10000",
      dayGain: "1250",
    });
  });

  it("consumes the oldest purchase lot first without float drift", () => {
    const result = calculateAverageCostPortfolio(
      [
        { id: "2", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
        { id: "3", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "10", pricePerShare: "120", grossAmount: "1200" },
        { id: "4", accountId: "a", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "5", pricePerShare: "140", grossAmount: "700" },
      ],
      [security],
    );
    expect(result.holdings[0].quantity).toBe("15");
    expect(result.holdings[0].totalCost).toBe("1700");
    expect(result.realizedGain).toBe("200");
    expect(result.unrealizedGain).toBe("550");
    expect(result.totalGain).toBe("750");
    expect(result.totalValue).toBe("2250");
  });

  it("matches sales only inside the same brokerage and account-type group", () => {
    const result = calculateAverageCostPortfolio(
      [
        { id: "taxable-buy", accountId: "sbi-taxable", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
        { id: "nisa-buy", accountId: "sbi-nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "10", pricePerShare: "200", grossAmount: "2000" },
        { id: "nisa-sell", accountId: "sbi-nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "5", pricePerShare: "250", grossAmount: "1250" },
      ],
      [security],
    );

    expect(result.holdings[0]).toMatchObject({ quantity: "15", totalCost: "2000" });
    expect(result.realizedGain).toBe("250");
  });

  it("shares FIFO lots across account IDs with the same brokerage and account type", () => {
    const result = calculateAverageCostPortfolio(
      [
        { id: "buy-old", accountId: "sbi-jp", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "5", pricePerShare: "100", grossAmount: "500" },
        { id: "buy-new", accountId: "sbi-us", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "5", pricePerShare: "200", grossAmount: "1000" },
        { id: "sell", accountId: "sbi-us", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "5", pricePerShare: "150", grossAmount: "750" },
      ],
      [security],
    );

    expect(result.holdings[0]).toMatchObject({ quantity: "5", totalCost: "1000", averageCost: "200" });
    expect(result.realizedGain).toBe("250");
  });

  it("records cost basis for a transferred-in position", () => {
    const result = calculateAverageCostPortfolio(
      [
        { id: "2", accountId: "a", securityId: "sec-a", type: "TRANSFER_IN", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
      ],
      [security],
    );
    expect(result.holdings[0].totalCost).toBe("1000");
    expect(result.totalValue).toBe("1500");
  });

  it("does not invent a market value when a quote is unavailable", () => {
    const result = calculateAverageCostPortfolio(
      [{ id: "1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      [{ ...security, quote: undefined }],
    );
    expect(result.holdings[0].marketValue).toBeNull();
    expect(result.holdings[0].unrealizedGain).toBeNull();
    expect(result.unpricedSecurityCount).toBe(1);
    expect(result.quoteCoveragePercent).toBe("0");
  });

  it("applies a remote split before valuing the open position", () => {
    const result = calculateAverageCostPortfolio(
      [{ id: "1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      [{ ...security, quote: { ...security.quote!, price: "60" } }],
      [{ id: "split-1", securityId: "sec-a", type: "SPLIT", effectiveDate: "2026-02-01", numerator: "2", denominator: "1", sourceProvider: "fixture" }],
    );
    expect(result.holdings[0].quantity).toBe("20");
    expect(result.holdings[0].averageCost).toBe("50");
    expect(result.holdings[0].marketValue).toBe("1200");
  });
});

describe("dividend income", () => {
  it("uses the quantity held before ex-date trades and keeps account entitlements separate", () => {
    const transactions = [
      { id: "buy-before", accountId: "taxable", securityId: "sec-a", type: "BUY" as const, tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
      { id: "sell-on-ex", accountId: "taxable", securityId: "sec-a", type: "SELL" as const, tradeDate: "2026-03-10", quantity: "4", pricePerShare: "150", grossAmount: "600" },
      { id: "buy-on-ex", accountId: "nisa", securityId: "sec-a", type: "BUY" as const, tradeDate: "2026-03-10", quantity: "5", pricePerShare: "150", grossAmount: "750" },
    ];
    const result = calculateDividendIncome(transactions, [{
      id: "sec-a-div-20260310",
      securityId: "sec-a",
      type: "CASH_DIVIDEND",
      exDate: "2026-03-10",
      paymentDate: "2026-04-01",
      amountPerUnit: "12.5",
      currency: "JPY",
      sourceProvider: "fixture",
      confidence: "reported",
    }]);

    expect(result.receipts).toEqual([expect.objectContaining({
      accountId: "taxable",
      eligibleQuantity: "10",
      grossAmount: "125",
      recognitionDate: "2026-04-01",
    })]);
    expect(result.totalIncome).toBe("125");
  });

  it("applies splits before entitlement and handles fund distributions per 10,000 units exactly", () => {
    const result = calculateDividendIncome(
      [{ id: "buy", accountId: "fund", securityId: "sec-blackrock", type: "BUY", tradeDate: "2026-01-02", quantity: "25000", pricePerShare: "16000", grossAmount: "40000" }],
      [{
        id: "blackrock-20260825",
        securityId: "sec-blackrock",
        type: "FUND_DISTRIBUTION",
        exDate: "2026-08-25",
        amountPerUnit: "130",
        distributionUnit: "10000",
        currency: "JPY",
        sourceProvider: "fixture",
        confidence: "official",
      }],
      [{ id: "split", securityId: "sec-blackrock", type: "SPLIT", effectiveDate: "2026-08-25", numerator: "2", denominator: "1", sourceProvider: "fixture" }],
    );

    expect(result.receipts[0]).toMatchObject({ eligibleQuantity: "50000", grossAmount: "650" });
  });

  it("calculates dividends across multiple different stocks with canonical security matching", () => {
    const transactions = [
      { id: "buy-toyota", accountId: "acc-jp", securityId: "sec-7203", type: "BUY" as const, tradeDate: "2025-01-01", quantity: "100", pricePerShare: "2000", grossAmount: "200000" },
      { id: "buy-ntt", accountId: "acc-jp", securityId: "sec-9432-xtks", type: "BUY" as const, tradeDate: "2025-01-01", quantity: "1000", pricePerShare: "160", grossAmount: "160000" },
      { id: "buy-vym", accountId: "acc-us", securityId: "sec-us-vym", type: "BUY" as const, tradeDate: "2025-01-01", quantity: "50", pricePerShare: "120", grossAmount: "6000" },
      { id: "buy-aapl", accountId: "acc-us", securityId: "sec-us-aapl-xnas", type: "BUY" as const, tradeDate: "2025-01-01", quantity: "20", pricePerShare: "200", grossAmount: "4000" },
    ];
    const distributions = [
      { id: "div-toyota", securityId: "sec-7203-xtks", type: "CASH_DIVIDEND" as const, exDate: "2025-03-27", amountPerUnit: "35", currency: "JPY", sourceProvider: "fixture", confidence: "official" as const },
      { id: "div-ntt", securityId: "sec-9432", type: "CASH_DIVIDEND" as const, exDate: "2025-03-27", amountPerUnit: "2.6", currency: "JPY", sourceProvider: "fixture", confidence: "official" as const },
      { id: "div-vym", securityId: "sec-us-vym-arcx", type: "CASH_DIVIDEND" as const, exDate: "2025-03-20", amountPerUnit: "0.95", currency: "USD", sourceProvider: "fixture", confidence: "official" as const },
      { id: "div-aapl", securityId: "sec-us-aapl", type: "CASH_DIVIDEND" as const, exDate: "2025-02-14", amountPerUnit: "0.25", currency: "USD", sourceProvider: "fixture", confidence: "official" as const },
    ];

    const summary = calculateDividendIncome(transactions, distributions);
    expect(summary.receipts).toHaveLength(4);
    expect(summary.bySecurity["sec-7203"]).toBe("3500");
    expect(summary.bySecurity["sec-9432-xtks"]).toBe("2600");
    expect(summary.bySecurity["sec-us-vym"]).toBe("47.5");
    expect(summary.bySecurity["sec-us-aapl-xnas"]).toBe("5");
    expect(summary.totalsByCurrency).toEqual({ JPY: "6100", USD: "52.5" });
  });

  it("ignores zero distributions and imported payments, and prefers official duplicate events", () => {
    const transactions = [
      { id: "buy", accountId: "a", securityId: "sec-a", type: "BUY" as const, tradeDate: "2025-01-01", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
      { id: "payment", accountId: "a", securityId: "sec-a", type: "DIVIDEND" as const, tradeDate: "2025-04-01", quantity: null, pricePerShare: null, grossAmount: "80" },
    ];
    const summary = calculateDividendIncome(transactions, [
      { id: "zero", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2025-02-01", amountPerUnit: "0", currency: "JPY", sourceProvider: "reported", confidence: "reported" },
      { id: "reported", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2025-03-01", amountPerUnit: "5", currency: "JPY", sourceProvider: "reported", confidence: "reported" },
      { id: "official", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2025-03-01", amountPerUnit: "6", currency: "JPY", sourceProvider: "official", confidence: "official" },
    ]);

    expect(summary.receipts).toHaveLength(1);
    expect(summary.receipts[0]).toMatchObject({ distributionId: "official", grossAmount: "60" });
    expect(summary.totalIncome).toBe("60");
  });

  it("adds distributions to realized and total gain without pretending they are current cash", () => {
    const result = calculateAverageCostPortfolio(
      [{ id: "buy", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      [security],
      [],
      [{ id: "div", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2026-02-01", amountPerUnit: "5", currency: "JPY", sourceProvider: "fixture", confidence: "reported" }],
      "2026-08-07",
    );

    expect(result).toMatchObject({
      cashValue: "0",
      capitalRealizedGain: "0",
      distributionIncome: "50",
      realizedGain: "50",
      unrealizedGain: "500",
      totalGain: "550",
    });
    expect(result.holdings[0]).toMatchObject({ distributionIncome: "50", realizedGain: "50" });
  });
});

describe("portfolio history", () => {
  it("reconstructs valuation only from remote market bars", () => {
    const points = reconstructPortfolioHistory(
      [{ id: "1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      [{ ...security, quote: undefined }],
      [
        { securityId: "sec-a", date: "2026-01-02", close: "110", provider: "fixture" },
        { securityId: "sec-a", date: "2026-01-03", close: "120", provider: "fixture" },
      ],
    );
    expect(points.map((point) => point.totalValue)).toEqual(["1100", "1200"]);
    expect(points.map((point) => point.costBasis)).toEqual(["1000", "1000"]);
    expect(points.map((point) => point.unrealizedGain)).toEqual(["100", "200"]);
  });

  it("adds recognized dividends to the total-return series while preserving market value", () => {
    const points = reconstructPortfolioHistory(
      [{ id: "1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" }],
      [{ ...security, quote: undefined }],
      [
        { securityId: "sec-a", date: "2026-01-02", close: "100", provider: "fixture" },
        { securityId: "sec-a", date: "2026-01-03", close: "95", provider: "fixture" },
      ],
      [],
      "2026-01-03",
      [{ id: "div", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2026-01-03", amountPerUnit: "10", currency: "JPY", sourceProvider: "fixture", confidence: "reported" }],
    );

    expect(points.at(-1)).toMatchObject({
      totalValue: "950",
      totalReturnValue: "1050",
      distributionIncome: "100",
      realizedGain: "100",
      totalGain: "50",
    });
  });

  it("reconstructs a complete graph for a 50-security portfolio", () => {
    const securities = Array.from({ length: 50 }, (_, index) => ({
      id: `sec-${index}`,
      displaySymbol: `S${index}`,
      name: `Security ${index}`,
      exchangeMic: "XTKS",
    }));
    const transactions = securities.map((item, index) => ({
      id: `buy-${index}`,
      accountId: "a",
      securityId: item.id,
      type: "BUY" as const,
      tradeDate: "2025-01-01",
      quantity: "1",
      pricePerShare: "100",
      grossAmount: "100",
    }));
    const dates = Array.from({ length: 260 }, (_, index) => {
      const date = new Date("2025-01-01T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
    const bars = dates.flatMap((date, day) => securities.map((item) => ({
      securityId: item.id,
      date,
      close: String(100 + day),
      provider: "fixture",
    })));

    const points = reconstructPortfolioHistory(transactions, securities, bars);

    expect(points).toHaveLength(260);
    expect(points[0].totalValue).toBe("5000");
    expect(points[0].costBasis).toBe("5000");
    expect(points.at(-1)?.totalValue).toBe("17950");
    expect(points.at(-1)?.costBasis).toBe("5000");
  });

  it("keeps consecutive calendar dates when a US price series has a one-year hole", () => {
    const points = reconstructPortfolioHistory(
      [
        { id: "jp-buy", accountId: "a", securityId: "sec-jp", type: "BUY", tradeDate: "2024-01-02", quantity: "1", pricePerShare: "100", grossAmount: "100" },
        { id: "us-buy", accountId: "a", securityId: "sec-us", type: "BUY", tradeDate: "2024-01-02", quantity: "1", pricePerShare: "200", grossAmount: "200" },
      ],
      [
        { id: "sec-jp", displaySymbol: "JP", name: "Japan", exchangeMic: "XTKS" },
        { id: "sec-us", displaySymbol: "US", name: "United States", exchangeMic: "XNAS" },
      ],
      [
        { securityId: "sec-jp", date: "2024-01-02", close: "100", provider: "fixture" },
        { securityId: "sec-jp", date: "2025-01-06", close: "120", provider: "fixture" },
        { securityId: "sec-us", date: "2024-01-02", close: "200", provider: "fixture" },
        { securityId: "sec-us", date: "2025-01-06", close: "260", provider: "fixture" },
      ],
      [],
      "2025-01-06",
    );

    expect(points[0].date).toBe("2024-01-02");
    expect(points.at(-1)?.date).toBe("2025-01-06");
    expect(points).toHaveLength(371);
    expect(points.every((point, index) => index === 0 || new Date(`${point.date}T00:00:00Z`).getTime() - new Date(`${points[index - 1].date}T00:00:00Z`).getTime() === 86_400_000)).toBe(true);
  });

  it("handles multi-year history with split, partial sell, and dividends incrementally", () => {
    const transactions: LedgerTransaction[] = [
      { id: "buy-1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2023-01-10", quantity: "100", pricePerShare: "1000", grossAmount: "100000" },
      { id: "sell-1", accountId: "a", securityId: "sec-a", type: "SELL", tradeDate: "2023-06-15", quantity: "40", pricePerShare: "1500", grossAmount: "60000" },
      { id: "buy-2", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2024-02-01", quantity: "50", pricePerShare: "800", grossAmount: "40000" },
    ];
    const corporateActions: CorporateAction[] = [
      { id: "split-1", securityId: "sec-a", type: "SPLIT", effectiveDate: "2023-09-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
    ];
    const distributions: DistributionEvent[] = [
      { id: "div-1", securityId: "sec-a", type: "CASH_DIVIDEND", exDate: "2023-12-01", amountPerUnit: "25", currency: "JPY", sourceProvider: "fixture", confidence: "official" },
    ];
    const bars: MarketBar[] = [
      { securityId: "sec-a", date: "2023-01-10", close: "1000", provider: "fixture" },
      { securityId: "sec-a", date: "2023-06-15", close: "1500", provider: "fixture" },
      { securityId: "sec-a", date: "2023-09-01", close: "750", provider: "fixture" },
      { securityId: "sec-a", date: "2023-12-01", close: "800", provider: "fixture" },
      { securityId: "sec-a", date: "2024-02-01", close: "800", provider: "fixture" },
      { securityId: "sec-a", date: "2024-06-01", close: "900", provider: "fixture" },
    ];

    const points = reconstructPortfolioHistory(
      transactions,
      [{ id: "sec-a", displaySymbol: "A", name: "Alpha", exchangeMic: "XTKS" }],
      bars,
      corporateActions,
      "2024-06-01",
      distributions,
    );

    // Initial buy: 100 shares @ 1000 = 100,000 cost basis
    expect(points[0].date).toBe("2023-01-10");
    expect(points[0].costBasis).toBe("100000");
    expect(points[0].totalValue).toBe("100000");

    // After partial sell of 40 shares: 60 shares remaining, cost basis 60,000. Realized gain = 60000 - 40000 = 20,000
    const pointAfterSell = points.find((p) => p.date === "2023-06-15");
    expect(pointAfterSell?.costBasis).toBe("60000");
    expect(pointAfterSell?.capitalRealizedGain).toBe("20000");

    // After 2:1 split: 60 shares become 120 shares, cost basis remains 60,000. Price 750 -> 120 * 750 = 90,000
    const pointAfterSplit = points.find((p) => p.date === "2023-09-01");
    expect(pointAfterSplit?.costBasis).toBe("60000");
    expect(pointAfterSplit?.totalValue).toBe("90000");

    // Final point
    const finalPoint = points.at(-1);
    expect(finalPoint?.date).toBe("2024-06-01");
    // 120 shares from before + 50 new shares = 170 shares @ 900 = 153,000
    expect(finalPoint?.totalValue).toBe("153000");
    expect(finalPoint?.costBasis).toBe("100000");
  });
});

describe("security history", () => {
  it("keeps every market date and records zero while the position is closed", () => {
    const points = reconstructSecurityHistory(
      "sec-a",
      [
        { securityId: "sec-a", date: "2026-01-02", close: "100", provider: "fixture" },
        { securityId: "sec-a", date: "2026-01-03", close: "110", provider: "fixture" },
        { securityId: "sec-a", date: "2026-02-03", close: "120", provider: "fixture" },
        { securityId: "sec-a", date: "2026-03-03", close: "130", provider: "fixture" },
      ],
      [
        { id: "buy-1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
        { id: "sell-1", accountId: "a", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-03", quantity: "10", pricePerShare: "110", grossAmount: "1100" },
        { id: "buy-2", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-03-03", quantity: "5", pricePerShare: "130", grossAmount: "650" },
      ],
    );

    expect(points.map(({ date, price, value, capital, quantity }) => ({ date, price, value, capital, quantity }))).toEqual([
      { date: "2026-01-02", price: 100, value: 1000, capital: 1000, quantity: 10 },
      { date: "2026-01-03", price: 110, value: 0, capital: 0, quantity: 0 },
      { date: "2026-02-03", price: 120, value: 0, capital: 0, quantity: 0 },
      { date: "2026-03-03", price: 130, value: 650, capital: 650, quantity: 5 },
    ]);
  });

  it("reconstructs historical capital with brokerage/account-type FIFO isolation", () => {
    const points = reconstructSecurityHistory(
      "sec-a",
      [
        { securityId: "sec-a", date: "2026-01-02", close: "100", provider: "fixture" },
        { securityId: "sec-a", date: "2026-01-03", close: "200", provider: "fixture" },
        { securityId: "sec-a", date: "2026-01-04", close: "250", provider: "fixture" },
      ],
      [
        { id: "taxable-buy", accountId: "taxable", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
        { id: "nisa-buy", accountId: "nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "10", pricePerShare: "200", grossAmount: "2000" },
        { id: "nisa-sell", accountId: "nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "5", pricePerShare: "250", grossAmount: "1250" },
      ],
    );

    expect(points.at(-1)).toMatchObject({ quantity: 15, capital: 2000, value: 3750 });
  });
});

describe("splits", () => {
  it("changes quantity and unit cost while preserving basis", () => {
    const adjusted = applySplit("10", "1200", "3", "1");
    expect(adjusted).toEqual({ quantity: "30", unitCost: "400" });
  });

  it("adjusts all historical transactions (both open and closed positions) to split-adjusted units", () => {
    const rawTrades = [
      { id: "buy-old", accountId: "a", securityId: "sec-a", type: "BUY" as const, tradeDate: "2020-01-10", quantity: "10", pricePerShare: "1000", grossAmount: "10000", source: "import" },
      { id: "sell-old", accountId: "a", securityId: "sec-a", type: "SELL" as const, tradeDate: "2020-02-10", quantity: "10", pricePerShare: "1200", grossAmount: "12000" },
      { id: "buy-new", accountId: "a", securityId: "sec-a", type: "BUY" as const, tradeDate: "2021-01-10", quantity: "10", pricePerShare: "160", grossAmount: "1600" },
    ];
    const actions = [
      { id: "split-10to1", securityId: "sec-a", type: "SPLIT" as const, effectiveDate: "2020-08-31", numerator: "10", denominator: "1", sourceProvider: "fixture" },
    ];

    const adjusted = deriveSplitAdjustedTransactions(rawTrades, actions);

    // Old buy and sell prior to split are adjusted 10x in quantity and 1/10 in unit price
    expect(adjusted[0]).toMatchObject({ quantity: "100", pricePerShare: "100", grossAmount: "10000", source: "import" });
    expect(adjusted[1]).toMatchObject({ quantity: "100", pricePerShare: "120", grossAmount: "12000" });
    // Trade after split is untouched
    expect(adjusted[2]).toMatchObject({ quantity: "10", pricePerShare: "160", grossAmount: "1600" });

    // Snapshots progression is completely seamless: 0 -> 100 -> 0 -> 10
    const snapshots = deriveTransactionPositionSnapshots(rawTrades, actions);
    expect(snapshots.get("buy-old")).toMatchObject({ beforeQuantity: "0", afterQuantity: "100" });
    expect(snapshots.get("sell-old")).toMatchObject({ beforeQuantity: "100", afterQuantity: "0" });
    expect(snapshots.get("buy-new")).toMatchObject({ beforeQuantity: "0", afterQuantity: "10" });
  });

  it("adjusts open historical positions from the effective date without reopening a sold position", () => {
    const bars = [
      { securityId: "sec-open", date: "2026-01-02", close: "1000", provider: "fixture" },
      { securityId: "sec-open", date: "2026-02-02", close: "500", provider: "fixture" },
      { securityId: "sec-closed", date: "2026-01-02", close: "1000", provider: "fixture" },
      { securityId: "sec-closed", date: "2026-01-10", close: "1100", provider: "fixture" },
      { securityId: "sec-closed", date: "2026-02-02", close: "550", provider: "fixture" },
    ];
    const actions = [
      { id: "open-split", securityId: "sec-open", type: "SPLIT" as const, effectiveDate: "2026-02-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
      { id: "closed-split", securityId: "sec-closed", type: "SPLIT" as const, effectiveDate: "2026-02-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
    ];
    const open = reconstructSecurityHistory("sec-open", bars, [
      { id: "open-buy", accountId: "a", securityId: "sec-open", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "1000", grossAmount: "10000" },
    ], actions);
    const closed = reconstructSecurityHistory("sec-closed", bars, [
      { id: "closed-buy", accountId: "a", securityId: "sec-closed", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "1000", grossAmount: "10000" },
      { id: "closed-sell", accountId: "a", securityId: "sec-closed", type: "SELL", tradeDate: "2026-01-10", quantity: "10", pricePerShare: "1100", grossAmount: "11000" },
    ], actions);

    expect(open).toEqual([
      { date: "2026-01-02", price: 1000, value: 10000, capital: 10000, quantity: 10 },
      { date: "2026-02-02", price: 500, value: 10000, capital: 10000, quantity: 20 },
    ]);
    expect(closed.at(-1)).toMatchObject({ date: "2026-02-02", quantity: 0, value: 0, capital: 0 });
  });
});

describe("transaction position snapshots", () => {
  it("records held shares immediately before and after every trade", () => {
    const snapshots = deriveTransactionPositionSnapshots([
      { id: "buy-1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
      { id: "buy-2", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "5", pricePerShare: "110", grossAmount: "550" },
      { id: "sell-1", accountId: "a", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "6", pricePerShare: "120", grossAmount: "720" },
    ]);

    expect(snapshots.get("buy-1")).toMatchObject({ beforeQuantity: "0", afterQuantity: "10" });
    expect(snapshots.get("buy-2")).toMatchObject({ beforeQuantity: "10", afterQuantity: "15" });
    expect(snapshots.get("sell-1")).toMatchObject({ beforeQuantity: "15", afterQuantity: "9" });
  });

  it("applies stock splits before subsequent transaction snapshots", () => {
    const snapshots = deriveTransactionPositionSnapshots(
      [
        { id: "buy-1", accountId: "a", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
        { id: "sell-1", accountId: "a", securityId: "sec-a", type: "SELL", tradeDate: "2026-02-02", quantity: "5", pricePerShare: "60", grossAmount: "300" },
      ],
      [{ id: "split-1", securityId: "sec-a", type: "SPLIT", effectiveDate: "2026-02-01", numerator: "2", denominator: "1", sourceProvider: "fixture" }],
    );

    expect(snapshots.get("sell-1")).toMatchObject({ beforeQuantity: "20", afterQuantity: "15" });
  });

  it("shows before and after quantities only for the transaction's matching account group", () => {
    const snapshots = deriveTransactionPositionSnapshots([
      { id: "taxable-buy", accountId: "taxable", costBasisGroup: "sbi\u0000taxable", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-02", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
      { id: "nisa-buy", accountId: "nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "BUY", tradeDate: "2026-01-03", quantity: "20", pricePerShare: "100", grossAmount: "2000" },
      { id: "nisa-sell", accountId: "nisa", costBasisGroup: "sbi\u0000nisa", securityId: "sec-a", type: "SELL", tradeDate: "2026-01-04", quantity: "5", pricePerShare: "120", grossAmount: "600" },
    ]);

    expect(snapshots.get("nisa-sell")).toMatchObject({ beforeQuantity: "20", afterQuantity: "15" });
  });

  it("handles multi-stage consecutive stock splits with exact cumulative multipliers", () => {
    const actions = [
      { id: "split-2024", securityId: "sec-ms", type: "SPLIT" as const, effectiveDate: "2024-06-01", numerator: "2", denominator: "1", sourceProvider: "fixture" },
      { id: "split-2025", securityId: "sec-ms", type: "SPLIT" as const, effectiveDate: "2025-06-01", numerator: "3", denominator: "1", sourceProvider: "fixture" },
    ];
    const trades = [
      // Trade 1 (before split 1): Subject to 2 * 3 = 6x multiplier
      { id: "t1", accountId: "a", securityId: "sec-ms", type: "BUY" as const, tradeDate: "2024-01-10", quantity: "10", pricePerShare: "600", grossAmount: "6000" },
      // Trade 2 (between split 1 and 2): Subject to 3x multiplier
      { id: "t2", accountId: "a", securityId: "sec-ms", type: "BUY" as const, tradeDate: "2024-10-10", quantity: "10", pricePerShare: "300", grossAmount: "3000" },
      // Trade 3 (after split 2): Subject to 1x multiplier (untouched)
      { id: "t3", accountId: "a", securityId: "sec-ms", type: "BUY" as const, tradeDate: "2025-10-10", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
    ];

    const adjusted = deriveSplitAdjustedTransactions(trades, actions);
    expect(adjusted[0]).toMatchObject({ quantity: "60", pricePerShare: "100", grossAmount: "6000" });
    expect(adjusted[1]).toMatchObject({ quantity: "30", pricePerShare: "100", grossAmount: "3000" });
    expect(adjusted[2]).toMatchObject({ quantity: "10", pricePerShare: "100", grossAmount: "1000" });

    // Snapshot progression tracks 0 -> 60 -> 90 -> 100 shares
    const snapshots = deriveTransactionPositionSnapshots(trades, actions);
    expect(snapshots.get("t1")).toMatchObject({ beforeQuantity: "0", afterQuantity: "60" });
    expect(snapshots.get("t2")).toMatchObject({ beforeQuantity: "60", afterQuantity: "90" });
    expect(snapshots.get("t3")).toMatchObject({ beforeQuantity: "90", afterQuantity: "100" });
  });

  it("handles high-precision fractional share splits without floating-point error", () => {
    const actions = [
      { id: "split-frac", securityId: "sec-frac", type: "SPLIT" as const, effectiveDate: "2026-06-29", numerator: "4", denominator: "1", sourceProvider: "fixture" },
    ];
    const trades = [
      { id: "buy-frac", accountId: "a", securityId: "sec-frac", type: "BUY" as const, tradeDate: "2026-01-10", quantity: "135.091525", pricePerShare: "4864", grossAmount: "657085.1776" },
    ];

    const adjusted = deriveSplitAdjustedTransactions(trades, actions);
    // 135.091525 * 4 = 540.3661
    expect(adjusted[0].quantity).toBe("540.3661");
    // 4864 / 4 = 1216
    expect(adjusted[0].pricePerShare).toBe("1216");
    expect(adjusted[0].grossAmount).toBe("657085.1776");
  });

  it("does not adjust trades executed on or after the exact ex-date", () => {
    const actions = [
      { id: "split-boundary", securityId: "sec-b", type: "SPLIT" as const, effectiveDate: "2026-06-29", numerator: "2", denominator: "1", sourceProvider: "fixture" },
    ];
    const trades = [
      { id: "pre-split", accountId: "a", securityId: "sec-b", type: "BUY" as const, tradeDate: "2026-06-28", quantity: "10", pricePerShare: "200", grossAmount: "2000" },
      { id: "on-split-date", accountId: "a", securityId: "sec-b", type: "BUY" as const, tradeDate: "2026-06-29", quantity: "10", pricePerShare: "100", grossAmount: "1000" },
    ];

    const adjusted = deriveSplitAdjustedTransactions(trades, actions);
    // Pre-split trade is adjusted 2x
    expect(adjusted[0]).toMatchObject({ quantity: "20", pricePerShare: "100", grossAmount: "2000" });
    // On-ex-date trade is NOT adjusted
    expect(adjusted[1]).toMatchObject({ quantity: "10", pricePerShare: "100", grossAmount: "1000" });
  });

  it("calculates dividend income accurately across Japanese stocks, US stocks, US ETFs, and mutual funds", () => {
    const trades: LedgerTransaction[] = [
      // JP Stock (Toyota): 100 shares bought 2025-01-10
      { id: "t-jp", accountId: "acc-tokyo", securityId: "sec-7203-xtks", type: "BUY", tradeDate: "2025-01-10", quantity: "100", pricePerShare: "3000", grossAmount: "300000" },
      // US Stock (Apple): 20 shares bought 2025-01-10
      { id: "t-us", accountId: "acc-ny", securityId: "sec-us-aapl-xnas", type: "BUY", tradeDate: "2025-01-10", quantity: "20", pricePerShare: "200", grossAmount: "4000" },
      // US ETF (VYM): 50 shares bought 2025-01-10
      { id: "t-etf", accountId: "acc-ny", securityId: "sec-us-vym-arcx", type: "BUY", tradeDate: "2025-01-10", quantity: "50", pricePerShare: "120", grossAmount: "6000" },
      // JP Mutual Fund (eMAXIS): 50,000 units bought 2025-01-10
      { id: "t-fund", accountId: "acc-tokyo", securityId: "sec-jp-fund-0331418a", type: "BUY", tradeDate: "2025-01-10", quantity: "50000", pricePerShare: "25000", grossAmount: "125000" },
    ];

    const distributions: DistributionEvent[] = [
      // JP Stock: ¥40 / share -> 100 * 40 = ¥4,000
      { id: "d-jp", securityId: "sec-7203", paymentDate: "2025-06-25", exDate: "2025-03-28", recordDate: "2025-03-31", amountPerUnit: "40", currency: "JPY", type: "CASH_DIVIDEND", confidence: "official", sourceProvider: "fixture" },
      // US Stock: $0.25 / share -> 20 * 0.25 = $5.00
      { id: "d-us", securityId: "sec-us-aapl", paymentDate: "2025-05-15", exDate: "2025-05-09", recordDate: "2025-05-12", amountPerUnit: "0.25", currency: "USD", type: "CASH_DIVIDEND", confidence: "official", sourceProvider: "fixture" },
      // US ETF: $0.85 / share -> 50 * 0.85 = $42.50
      { id: "d-etf", securityId: "sec-us-vym", paymentDate: "2025-06-20", exDate: "2025-06-16", recordDate: "2025-06-17", amountPerUnit: "0.85", currency: "USD", type: "CASH_DIVIDEND", confidence: "official", sourceProvider: "fixture" },
      // JP Fund: ¥50 / 10,000 units -> (50,000 / 10,000) * 50 = ¥250
      { id: "d-fund", securityId: "sec-jp-fund-0331418a", paymentDate: "2025-07-15", exDate: "2025-07-14", recordDate: "2025-07-14", amountPerUnit: "50", distributionUnit: "10000", currency: "JPY", type: "FUND_DISTRIBUTION", confidence: "official", sourceProvider: "fixture" },
    ];

    const summary = calculateDividendIncome(trades, distributions, [], "2025-12-31");
    expect(summary.receipts).toHaveLength(4);

    const jpReceipt = summary.receipts.find((r) => matchSecurityId(r.securityId, "sec-7203"));
    expect(jpReceipt).toBeDefined();
    expect(jpReceipt?.grossAmount).toBe("4000");
    expect(jpReceipt?.currency).toBe("JPY");
    expect(jpReceipt?.eligibleQuantity).toBe("100");

    const usReceipt = summary.receipts.find((r) => matchSecurityId(r.securityId, "sec-us-aapl"));
    expect(usReceipt).toBeDefined();
    expect(usReceipt?.grossAmount).toBe("5");
    expect(usReceipt?.currency).toBe("USD");
    expect(usReceipt?.eligibleQuantity).toBe("20");

    const etfReceipt = summary.receipts.find((r) => matchSecurityId(r.securityId, "sec-us-vym"));
    expect(etfReceipt).toBeDefined();
    expect(etfReceipt?.grossAmount).toBe("42.5");
    expect(etfReceipt?.currency).toBe("USD");
    expect(etfReceipt?.eligibleQuantity).toBe("50");

    const fundReceipt = summary.receipts.find((r) => matchSecurityId(r.securityId, "sec-jp-fund-0331418a"));
    expect(fundReceipt).toBeDefined();
    expect(fundReceipt?.grossAmount).toBe("250");
    expect(fundReceipt?.currency).toBe("JPY");
    expect(fundReceipt?.eligibleQuantity).toBe("50000");
    expect(fundReceipt?.distributionUnit).toBe("10000");
  });

  describe("canonicalDomainSecurityId & domainSecurityIdVariants", () => {
    it("canonicalizes Japanese alphanumeric and 4-digit symbols in all common forms", () => {
      // 285A Kioxia variants
      expect(canonicalDomainSecurityId("285A")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("285a")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("285A.T")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("285a.t")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("sec-285A")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("sec-285a")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("sec-285A-xtks")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("sec-285a-xtks")).toBe("sec-285a");
      expect(canonicalDomainSecurityId("sec-285a-tse")).toBe("sec-285a");

      // 7203 Toyota variants
      expect(canonicalDomainSecurityId("7203")).toBe("sec-7203");
      expect(canonicalDomainSecurityId("7203.T")).toBe("sec-7203");
      expect(canonicalDomainSecurityId("sec-7203-xtks")).toBe("sec-7203");
      expect(canonicalDomainSecurityId("sec-7203-tse")).toBe("sec-7203");
      expect(canonicalDomainSecurityId("sec-7203")).toBe("sec-7203");

      // US ticker variants
      expect(canonicalDomainSecurityId("sec-us-aapl-xnas")).toBe("sec-us-aapl");
      expect(canonicalDomainSecurityId("sec-us-aapl-xnys")).toBe("sec-us-aapl");
      expect(canonicalDomainSecurityId("sec-us-aapl")).toBe("sec-us-aapl");

      // Match check across representations
      expect(matchSecurityId("285A", "sec-285a-xtks")).toBe(true);
      expect(matchSecurityId("285A.T", "sec-285a")).toBe(true);
      expect(matchSecurityId("7203", "sec-7203-xtks")).toBe(true);
      expect(matchSecurityId("7203.T", "sec-7203")).toBe(true);
    });

    it("generates comprehensive variants for map indexing", () => {
      const kioxiaVariants = new Set(domainSecurityIdVariants("sec-285a"));
      expect(kioxiaVariants.has("sec-285a")).toBe(true);
      expect(kioxiaVariants.has("sec-285A")).toBe(true);
      expect(kioxiaVariants.has("sec-285a-xtks")).toBe(true);
      expect(kioxiaVariants.has("sec-285A-xtks")).toBe(true);
      expect(kioxiaVariants.has("285a")).toBe(true);
      expect(kioxiaVariants.has("285A")).toBe(true);
      expect(kioxiaVariants.has("285a.t")).toBe(true);
      expect(kioxiaVariants.has("285A.T")).toBe(true);

      const toyotaVariants = new Set(domainSecurityIdVariants("7203"));
      expect(toyotaVariants.has("sec-7203")).toBe(true);
      expect(toyotaVariants.has("sec-7203-xtks")).toBe(true);
      expect(toyotaVariants.has("7203")).toBe(true);
      expect(toyotaVariants.has("7203.T")).toBe(true);
    });
  });
});
