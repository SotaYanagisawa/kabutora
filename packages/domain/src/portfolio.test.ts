import { describe, expect, it } from "vitest";
import { marketKey, normalizeSplits, splitFactorAfter, type DailyHistory, type Quote } from "./market";
import {
  buildBook,
  convert,
  dividendReceipts,
  intradayHistory,
  portfolioHistory,
  previousCloseFor,
  securityHistory,
  tradeRows,
  valuePortfolio,
  withQuotes,
  type Fx,
  type LedgerSecurity,
  type LedgerTransaction,
  type MarketData,
} from "./portfolio";

const NO_FX: Fx = { now: null, previous: null, dates: [], closes: [] };
const TODAY = "2026-10-06";

const tx = (id: string, securityId: string, type: "BUY" | "SELL", tradeDate: string, quantity: number, price: number, extra: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, accountId: "a", securityId, type, tradeDate, quantity: String(quantity), pricePerShare: String(price), grossAmount: null, tradeCurrency: "JPY", ...extra,
});

const quote = (key: string, price: number, previousClose: number | null, extra: Partial<Quote> = {}): Quote => ({
  key, price, previousClose, time: Date.parse("2026-10-06T06:30:00Z") / 1000, session: "closed", venue: "TSE", currency: "JPY", fetchedAt: 0, ...extra,
});

const history = (key: string, rows: Array<[string, number]>, extra: Partial<DailyHistory> = {}): DailyHistory => ({
  key, currency: "JPY", dates: rows.map(([date]) => date), closes: rows.map(([, close]) => close), splits: [], dividends: [], fetchedAt: 0, ...extra,
});

const market = (quotes: Quote[], histories: DailyHistory[] = []): MarketData => ({
  quotes: new Map(quotes.map((item) => [item.key, item])),
  history: new Map(histories.map((item) => [item.key, item])),
});

const securities = (...items: LedgerSecurity[]) => new Map(items.map((item) => [item.id, item]));
const jp = (id: string): LedgerSecurity => ({ id, currency: "JPY" });

describe("market keys and splits", () => {
  it("maps every ledger spelling to one key", () => {
    expect(marketKey("sec-285a-xtks")).toBe("sec-285a");
    expect(marketKey("sec-285A")).toBe("sec-285a");
    expect(marketKey("285A.T")).toBe("sec-285a");
    expect(marketKey("sec-us-aapl-xnas")).toBe("sec-us-aapl");
    expect(marketKey("sec-jp-fund-02311886")).toBe("sec-jp-fund-02311886");
  });

  it("counts only splits strictly after the trade date", () => {
    const splits = [{ date: "2024-09-27", ratio: 3 }, { date: "2026-09-29", ratio: 2 }];
    expect(splitFactorAfter(splits, "2024-01-10")).toBe(6);
    expect(splitFactorAfter(splits, "2024-09-27")).toBe(2);
    expect(splitFactorAfter(splits, "2026-09-28")).toBe(2);
    expect(splitFactorAfter(splits, "2026-09-29")).toBe(1);
  });

  it("keeps one split per date and drops invalid ratios", () => {
    expect(normalizeSplits([
      { date: "2026-09-29", ratio: 3 }, { date: "2026-09-29", ratio: 3 }, { date: "2025-01-01", ratio: 0 }, { date: "2024-01-01", ratio: 2 },
    ])).toEqual([{ date: "2024-01-01", ratio: 2 }, { date: "2026-09-29", ratio: 3 }]);
  });
});

describe("valuePortfolio", () => {
  it("applies a split exactly once, whatever spelling the ledger uses", () => {
    const data = market([quote("sec-285a", 18_735, 19_120)], [history("sec-285a", [["2026-10-05", 19_120]], { splits: [{ date: "2026-09-29", ratio: 3 }] })]);
    const book = buildBook([
      tx("t1", "sec-285a-xtks", "BUY", "2025-12-15", 10, 9_440),
      tx("t2", "sec-285a", "BUY", "2026-03-09", 5, 18_000),
      tx("t3", "sec-285a-xtks", "BUY", "2026-10-01", 3, 19_000),
    ], securities(jp("sec-285a-xtks"), jp("sec-285a")), data);
    const result = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY });
    const total = result.holdings.reduce((sum, holding) => sum + holding.quantity, 0);
    expect(total).toBe(10 * 3 + 5 * 3 + 3);
    expect(result.summary.costBasis).toBe(94_400 + 90_000 + 57_000);
    expect(result.summary.totalValue).toBeCloseTo(48 * 18_735, 6);
    expect(result.holdings.find((holding) => holding.securityId === "sec-285a-xtks")?.averageCost).toBeCloseTo((94_400 + 57_000) / 33, 9);
  });

  it("supports reverse splits", () => {
    const data = market([quote("sec-9999", 5_000, 5_000)], [history("sec-9999", [], { splits: [{ date: "2026-01-05", ratio: 0.2 }] })]);
    const book = buildBook([tx("t", "sec-9999", "BUY", "2025-06-01", 100, 1_000)], securities(jp("sec-9999")), data);
    const holding = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY }).holdings[0];
    expect(holding.quantity).toBeCloseTo(20, 12);
    expect(holding.averageCost).toBeCloseTo(5_000, 9);
    expect(holding.marketValue).toBeCloseTo(100_000, 6);
  });

  it("uses the moving-average method per cost-basis group", () => {
    const data = market([quote("sec-1111", 2_500, 2_400)]);
    const book = buildBook([
      tx("b1", "sec-1111", "BUY", "2025-01-01", 100, 1_000),
      tx("b2", "sec-1111", "BUY", "2025-02-01", 100, 2_000),
      tx("s1", "sec-1111", "SELL", "2025-03-01", 50, 3_000),
      tx("b3", "sec-1111", "BUY", "2025-03-01", 10, 1_000, { accountId: "nisa" }),
    ], securities(jp("sec-1111")), data);
    const result = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY });
    expect(result.summary.realizedGain).toBe(50 * 3_000 - 50 * 1_500);
    expect(result.holdings[0].quantity).toBe(160);
    expect(result.holdings[0].costBasis).toBe(150 * 1_500 + 10_000);
    expect(result.holdings[0].unrealizedGain).toBe(160 * 2_500 - 235_000);
  });

  it("clamps oversold sales and reports them", () => {
    const book = buildBook([
      tx("b", "sec-1111", "BUY", "2025-01-01", 10, 100),
      tx("s", "sec-1111", "SELL", "2025-02-01", 15, 120),
    ], securities(jp("sec-1111")), market([quote("sec-1111", 130, 125)]));
    const result = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY });
    expect(book.issues).toEqual([{ transactionId: "s", reason: "oversold" }]);
    expect(result.holdings).toEqual([]);
    expect(result.summary.realizedGain).toBeCloseTo(10 * 120 - 1_000, 9);
  });

  it("values Japanese funds quoted per 10,000 units", () => {
    const fund: LedgerSecurity = { id: "sec-jp-fund-02314143", currency: "JPY", priceUnit: "10000" };
    const book = buildBook([tx("f", fund.id, "BUY", "2026-01-02", 25_000, 16_000)], securities(fund), market([quote(fund.id, 20_000, 19_500, { venue: "FUND" })]));
    const holding = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY }).holdings[0];
    expect(holding).toMatchObject({ quantity: 25_000, costBasis: 40_000, averageCost: 16_000, marketValue: 50_000, unrealizedGain: 10_000, dayGain: 1_250 });
  });

  it("converts USD positions with trade-date FX for cost and live FX for value", () => {
    const us: LedgerSecurity = { id: "sec-us-nvda-xnas", currency: "USD" };
    const fx: Fx = { now: 160, previous: 158, dates: ["2025-07-15"], closes: [150] };
    const data = market([quote("sec-us-nvda", 110, 100, { venue: "US", currency: "USD", time: Date.parse("2026-10-06T20:00:00Z") / 1000, session: "regular" })]);
    const book = buildBook([tx("u", us.id, "BUY", "2025-07-15", 10, 100, { tradeCurrency: "USD" })], securities(us), data);
    const jpy = valuePortfolio(book, { target: "JPY", fx, today: TODAY });
    expect(jpy.summary.costBasis).toBe(150_000);
    expect(jpy.summary.totalValue).toBe(176_000);
    expect(jpy.summary.dayGain).toBe(176_000 - 10 * 100 * 158);
    const native = valuePortfolio(book, { target: "NATIVE", fx, today: TODAY });
    expect(native.holdings[0]).toMatchObject({ currency: "USD", costBasis: 1_000, marketValue: 1_100, dayGain: 100 });
    expect(valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY }).summary.fxMissing).toBe(true);
  });

  it("counts shares bought today at their cost, not at the previous close", () => {
    const data = market([quote("sec-1111", 1_100, 1_000, { session: "regular" })], [history("sec-1111", [["2026-10-05", 1_000]])]);
    const book = buildBook([
      tx("old", "sec-1111", "BUY", "2026-01-05", 100, 900),
      tx("new", "sec-1111", "BUY", "2026-10-06", 50, 1_050),
    ], securities(jp("sec-1111")), data);
    const { summary } = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY });
    expect(summary.dayGain).toBe(100 * 100 + 50 * 50);
  });

  it("restricts to included trades", () => {
    const book = buildBook([
      tx("a", "sec-1111", "BUY", "2025-01-01", 1, 100),
      tx("b", "sec-2222", "BUY", "2025-01-01", 1, 200, { accountId: "other" }),
    ], securities(jp("sec-1111"), jp("sec-2222")), market([quote("sec-1111", 110, 100), quote("sec-2222", 220, 200)]));
    const result = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY, include: (trade) => trade.accountId === "other" });
    expect(result.summary.totalValue).toBe(220);
  });
});

describe("previousCloseFor", () => {
  it("prefers the split-adjusted daily close before the session", () => {
    const item = quote("sec-8316", 3_429, 6_700);
    const data = history("sec-8316", [["2026-10-02", 3_321], ["2026-10-05", 3_374]], { splits: [{ date: "2026-09-29", ratio: 2 }] });
    expect(previousCloseFor(item, data, "2026-10-06")).toBe(3_374);
  });

  it("repairs an unadjusted previous close on the split date", () => {
    const item = quote("sec-8316", 3_357, 6_700);
    const data = history("sec-8316", [], { splits: [{ date: "2026-09-29", ratio: 2 }] });
    expect(previousCloseFor(item, data, "2026-09-29")).toBe(3_350);
  });
});

describe("dividends", () => {
  it("pays units held before the ex-date, per account, in today's units", () => {
    const data = market([quote("sec-8316", 3_429, 3_374)], [history("sec-8316", [], {
      splits: [{ date: "2026-09-29", ratio: 2 }],
      dividends: [{ date: "2026-03-30", amount: 39.5 }, { date: "2026-09-29", amount: 45 }, { date: "2026-12-01", amount: 50 }],
    })]);
    const book = buildBook([
      tx("b", "sec-8316", "BUY", "2025-12-19", 100, 5_005),
      tx("n", "sec-8316", "BUY", "2026-09-29", 10, 3_350, { accountId: "nisa" }),
    ], securities(jp("sec-8316")), data);
    const receipts = dividendReceipts(book, { target: "JPY", fx: NO_FX, today: TODAY });
    expect(receipts.map((receipt) => [receipt.exDate, receipt.accountId, receipt.quantity, receipt.amount])).toEqual([
      ["2026-03-30", "a", 200, 7_900],
      ["2026-09-29", "a", 200, 9_000],
    ]);
  });
});

describe("history", () => {
  it("has no jump across a split and ends at the live total", () => {
    const data = market([quote("sec-285a", 18_735, 19_120)], [history("sec-285a", [
      ["2026-09-25", 18_000], ["2026-09-26", 18_100], ["2026-09-29", 17_880], ["2026-10-05", 19_120],
    ], { splits: [{ date: "2026-09-29", ratio: 3 }] })]);
    const book = buildBook([tx("t", "sec-285a", "BUY", "2026-09-25", 10, 54_000)], securities(jp("sec-285a")), data);
    const points = portfolioHistory(book, { target: "JPY", fx: NO_FX, today: TODAY });
    expect(points.map((point) => [point.date, point.value])).toEqual([
      ["2026-09-25", 540_000], ["2026-09-26", 543_000], ["2026-09-29", 536_400], ["2026-10-05", 573_600], [TODAY, 562_050],
    ]);
    expect(points.at(-1)!.value).toBe(valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY }).summary.totalValue);
    expect(points.every((point) => point.capital === 540_000)).toBe(true);
  });

  it("prices a security without daily closes at its last execution price", () => {
    const book = buildBook([tx("t", "sec-1111", "BUY", "2026-10-01", 2, 500)], securities(jp("sec-1111")), market([]));
    expect(portfolioHistory(book, { target: "JPY", fx: NO_FX, today: TODAY }).map((point) => point.value)).toEqual([1_000, 1_000]);
  });

  it("builds a security's position history and intraday portfolio values", () => {
    const data: MarketData = {
      ...market([quote("sec-1111", 120, 100, { time: Date.parse("2026-10-06T03:00:00Z") / 1000, session: "regular" })], [history("sec-1111", [["2026-10-05", 100]])]),
      intraday: new Map([["sec-1111", { times: [1_791_250_000, 1_791_251_000], prices: [105, 110] }]]),
    };
    const book = buildBook([tx("t", "sec-1111", "BUY", "2026-10-01", 10, 90)], securities(jp("sec-1111")), data);
    expect(securityHistory(book, "sec-1111", { target: "JPY", fx: NO_FX, today: TODAY }).map((point) => [point.date, point.value, point.capital])).toEqual([
      ["2026-10-05", 1_000, 900], [TODAY, 1_200, 900],
    ]);
    expect(intradayHistory(book, { target: "JPY", fx: NO_FX, today: TODAY, since: 0, now: 1_791_252_000 }).map((point) => point.value)).toEqual([1_050, 1_100, 1_200]);
  });
});

describe("extended sessions", () => {
  it("splits the day into the regular session and the PTS move", () => {
    const pts = quote("sec-285a", 18_900, 18_000, { session: "pts_night", venue: "JNX", regularPrice: 18_700, regularTime: Date.parse("2026-10-06T06:30:00Z") / 1000, time: Date.parse("2026-10-06T12:00:00Z") / 1000 });
    const book = buildBook([tx("t", "sec-285a", "BUY", "2026-09-01", 10, 15_000)], securities(jp("sec-285a")), market([pts]));
    const holding = valuePortfolio(book, { target: "JPY", fx: NO_FX, today: TODAY }).holdings[0];
    expect(holding.dayGain).toBe(9_000);
    expect(holding.extendedGain).toBe(2_000);
    expect(holding.regularGain).toBe(7_000);
    expect(holding.extendedChangeRatio).toBeCloseTo(18_900 / 18_700 - 1, 12);
    expect(holding.regularChangeRatio).toBeCloseTo(18_700 / 18_000 - 1, 12);
    expect((1 + holding.regularChangeRatio!) * (1 + holding.extendedChangeRatio!) - 1).toBeCloseTo(holding.dayChangeRatio!, 12);
  });
});

describe("re-pricing with new quotes", () => {
  it("matches a freshly built book while reusing the past days", () => {
    const usd: LedgerSecurity = { id: "sec-us-aapl", currency: "USD" };
    const fx: Fx = { now: 150, previous: 149, dates: ["2026-09-01", "2026-10-05"], closes: [140, 148] };
    const histories = [
      history("sec-285a", [["2026-09-25", 18_000], ["2026-09-29", 17_880], ["2026-10-05", 19_120]], { splits: [{ date: "2026-09-29", ratio: 3 }], dividends: [{ date: "2026-09-29", amount: 10 }] }),
      history("sec-us-aapl", [["2026-09-25", 250], ["2026-10-05", 255]], { currency: "USD" }),
    ];
    const transactions = [
      tx("t1", "sec-285a", "BUY", "2026-09-25", 10, 54_000),
      tx("t2", "sec-us-aapl", "BUY", "2026-09-25", 4, 250, { tradeCurrency: "USD" }),
      tx("t3", "sec-285a", "SELL", TODAY, 5, 18_800),
    ];
    const ledger = securities(jp("sec-285a"), usd);
    const first = market([quote("sec-285a", 18_735, 19_120), quote("sec-us-aapl", 256, 255, { venue: "US", currency: "USD" })], histories);
    const book = buildBook(transactions, ledger, first);
    for (const target of ["JPY", "USD"] as const) portfolioHistory(book, { target, fx, today: TODAY });

    const later: MarketData = { ...first, quotes: market([quote("sec-285a", 18_900, 19_120), quote("sec-us-aapl", 251, 255, { venue: "US", currency: "USD" })]).quotes };
    const repriced = withQuotes(book, later);
    const fresh = buildBook(transactions, ledger, later);
    const laterFx = { ...fx, now: 151 };
    for (const target of ["JPY", "USD", "NATIVE"] as const) {
      expect(portfolioHistory(repriced, { target: target === "NATIVE" ? "JPY" : target, fx: laterFx, today: TODAY }))
        .toEqual(portfolioHistory(fresh, { target: target === "NATIVE" ? "JPY" : target, fx: laterFx, today: TODAY }));
      expect(valuePortfolio(repriced, { target, fx: laterFx, today: TODAY })).toEqual(valuePortfolio(fresh, { target, fx: laterFx, today: TODAY }));
      expect(dividendReceipts(repriced, { target, fx: laterFx, today: TODAY })).toEqual(dividendReceipts(fresh, { target, fx: laterFx, today: TODAY }));
    }
    const points = portfolioHistory(repriced, { target: "JPY", fx: laterFx, today: TODAY });
    expect(points.at(-1)!.value).toBeCloseTo(valuePortfolio(repriced, { target: "JPY", fx: laterFx, today: TODAY }).summary.totalValue, 6);
    // A filter is part of the cache key.
    const onlyApple = (trade: { securityId: string }) => trade.securityId === "sec-us-aapl";
    expect(portfolioHistory(repriced, { target: "USD", fx: laterFx, today: TODAY, include: onlyApple }).at(-1)!.value).toBe(4 * 251);
  });
});

describe("tradeRows", () => {
  it("shows quantities, prices and holdings in today's units", () => {
    const data = market([], [history("sec-8053", [], { splits: [{ date: "2026-06-29", ratio: 4 }] })]);
    const book = buildBook([
      tx("b", "sec-8053-xtks", "BUY", "2025-10-23", 100, 4_571),
      tx("s", "sec-8053-xtks", "SELL", "2026-07-01", 40, 1_700),
    ], securities(jp("sec-8053-xtks")), data);
    const rows = tradeRows(book);
    expect(rows.get("b")).toEqual({ quantity: 400, price: 1_142.75, splitFactor: 4, before: 0, after: 400 });
    expect(rows.get("s")).toEqual({ quantity: 40, price: 1_700, splitFactor: 1, before: 400, after: 360 });
  });
});

describe("convert", () => {
  it("converts only between JPY and USD", () => {
    expect(convert(10, "USD", "JPY", 150)).toBe(1_500);
    expect(convert(1_500, "JPY", "USD", 150)).toBe(10);
    expect(convert(1, "EUR", "JPY", 150)).toBeNull();
    expect(convert(1, "USD", "JPY", null)).toBeNull();
  });
});
