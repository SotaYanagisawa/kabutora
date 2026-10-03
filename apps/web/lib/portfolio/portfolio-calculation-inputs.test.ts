import { describe, expect, it } from "vitest";
import { Decimal } from "@kabutora/domain";
import { calculatePortfolio, indexHistoryDataset, type HistoryDataset } from "./portfolio-history-calculation";
import { convertCalculationDataset } from "./portfolio-calculation-inputs";

const source: HistoryDataset = {
  transactions: [
    { id: "buy", accountId: "one", securityId: "sec-us-aapl-xnas", type: "BUY", tradeDate: "2026-08-01", quantity: "0.1", pricePerShare: "0.2", grossAmount: "0.02", tradeCurrency: "USD" },
    { id: "fund", accountId: "two", securityId: "sec-jp-fund-123", type: "BUY", tradeDate: "2026-08-01", quantity: "10000", pricePerShare: "200.1", grossAmount: "200.1", tradeCurrency: "JPY" },
  ],
  securities: [
    { id: "sec-us-aapl-xnas", displaySymbol: "AAPL", name: "Apple", exchangeMic: "XNAS", currency: "USD", quote: { price: "0.3", previousRegularClose: "0.2", marketTimestamp: "2026-08-01", fetchedAt: "2026-08-01", freshness: "cached", provider: "fixture", session: "closed", priceType: "official_close", venueCode: "US", validationStatus: "valid" } },
    { id: "sec-jp-fund-123", displaySymbol: "123", name: "Fund", exchangeMic: "JPFD", currency: "JPY", priceUnit: "10000" },
  ],
  bars: [{ securityId: "sec-us-aapl-xnas", date: "2026-08-01", close: "0.3", provider: "fixture" }, { securityId: "sec-fx-usdjpy", date: "2026-08-01", close: "150.123", provider: "fixture" }],
  fx: { current: 150.123, previous: 150.123 }, corporateActions: [], distributions: [], dividendReceipts: [],
};
describe("revisioned complete accounting calculation", () => {
  it("publishes Decimal holdings, totals and history for one currency revision", async () => {
    const result = await calculatePortfolio(indexHistoryDataset(source), { transactionIds: ["buy"], throughDate: "2026-08-01", currency: "JPY" }, new AbortController().signal);
    expect(result.summary.holdings[0].marketValue).toBe("4.50369");
    expect(result.summary.costBasis).toBe("3.00246");
    expect(result.nativeSummary.holdings[0].marketValue).toBe("0.03");
    expect(result.points.at(-1)?.totalValue).toBe(result.summary.securitiesValue);
  });
  it("preserves fund units and caches at most two currency conversions", async () => {
    const index = indexHistoryDataset(source);
    for (const currency of ["JPY", "USD", "JPY", "USD"]) await calculatePortfolio(index, { transactionIds: ["fund"], throughDate: "2026-08-01", currency }, new AbortController().signal);
    expect(index.currencies.size).toBe(2);
    const usd = index.currencies.get("USD:2026-08-01")!;
    expect(usd.transactions.get("fund")?.quantity).toBe("10000");
    expect(usd.transactions.get("fund")?.grossAmount).toBe(new Decimal("200.1").div("150.123").toString());
  });
  it("keeps holdings units and marks prices unavailable when no FX exists", async () => {
    const dataset = await convertCalculationDataset({ ...source, bars: [], fx: { current: null, previous: null } }, "JPY", "2026-08-01", new AbortController().signal);
    expect(dataset.transactions[0].quantity).toBe("0.1");
    expect(dataset.transactions[0].grossAmount).toBeNull();
    expect(dataset.securities[0].quote).toBeUndefined();
  });
});
