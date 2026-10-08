import { describe, expect, it } from "vitest";
import { normalizeRequestedSecurity } from "../market/market-security";
import {
  normalizeDividends,
  parseBlackRockDistributions,
  parseChartHistory,
  parseFundDistributions,
  parseFundHistory,
  parseFundPage,
  parseMonexPage,
  parsePtsSource,
  parseSpark,
  parseTopixPage,
  ptsWindowAt,
  quoteFromSpark,
} from "./market-upstream";

describe("normalizeDividends", () => {
  const splits = [{ date: "2024-09-27", ratio: 3 }, { date: "2026-09-29", ratio: 2 }];

  it("divides a same-day dividend that is still per pre-split share (SMFG 2026-09)", () => {
    const result = normalizeDividends([{ date: "2026-03-30", amount: 39.5 }, { date: "2026-09-29", amount: 90 }], splits);
    expect(result.at(-1)).toEqual({ date: "2026-09-29", amount: 45 });
  });

  it("keeps a same-day dividend Yahoo already adjusted (SMFG 2024-09)", () => {
    const result = normalizeDividends([{ date: "2024-03-28", amount: 22.5 }, { date: "2024-09-27", amount: 30 }, { date: "2025-03-28", amount: 31 }], splits);
    expect(result[1]).toEqual({ date: "2024-09-27", amount: 30 });
  });

  it("handles Nippon Steel's 5:1 split on its interim record date", () => {
    const result = normalizeDividends([{ date: "2025-03-28", amount: 16 }, { date: "2025-09-29", amount: 60 }, { date: "2026-03-30", amount: 12 }], [{ date: "2025-09-29", ratio: 5 }]);
    expect(result[1]).toEqual({ date: "2025-09-29", amount: 12 });
  });

  it("sums events on one date and drops invalid amounts", () => {
    expect(normalizeDividends([{ date: "2026-01-02", amount: 1 }, { date: "2026-01-02", amount: 0.5 }, { date: "2026-02-02", amount: 0 }], [])).toEqual([{ date: "2026-01-02", amount: 1.5 }]);
  });
});

describe("parseChartHistory", () => {
  it("keys bars and events by the exchange date and keeps one split per date", () => {
    const tokyo = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const record = parseChartHistory({
      chart: {
        result: [{
          meta: { currency: "JPY", exchangeTimezoneName: "Asia/Tokyo" },
          timestamp: [tokyo("2026-09-26"), tokyo("2026-09-29"), tokyo("2026-09-30")],
          indicators: { quote: [{ close: [18_000, null, 18_100] }] },
          events: {
            splits: { a: { date: tokyo("2026-09-29"), numerator: 3, denominator: 1 }, b: { date: tokyo("2026-09-29") + 3_600, numerator: 3, denominator: 1 } },
            dividends: { c: { date: tokyo("2026-09-29"), amount: 30 } },
          },
        }],
      },
    }, "sec-285a", "JPY", 1);
    expect(record).toEqual({
      key: "sec-285a", currency: "JPY", dates: ["2026-09-26", "2026-09-30"], closes: [18_000, 18_100],
      splits: [{ date: "2026-09-29", ratio: 3 }], dividends: [{ date: "2026-09-29", amount: 10 }], fetchedAt: 1,
    });
  });

  it("dates US bars in New York", () => {
    const record = parseChartHistory({ chart: { result: [{ meta: { currency: "USD", exchangeTimezoneName: "America/New_York" }, timestamp: [Date.parse("2026-10-05T13:30:00Z") / 1000], indicators: { quote: [{ close: [255] }] }, events: {} }] } }, "sec-us-aapl", "USD", 1);
    expect(record.dates).toEqual(["2026-10-05"]);
  });
});

describe("spark quotes", () => {
  const security = normalizeRequestedSecurity("sec-us-aapl")!;
  const row = (overrides: Record<string, unknown>, closes: number[] = [101], times: number[] = [1_000]) => parseSpark({
    spark: { result: [{ symbol: "AAPL", response: [{ meta: { currency: "USD", regularMarketPrice: 100, regularMarketTime: 900, previousClose: 99, ...overrides }, timestamp: times, indicators: { quote: [{ close: closes }] } }] }] },
  }).get("AAPL")!;

  it("uses a newer extended-hours trade and labels it", () => {
    expect(quoteFromSpark("sec-us-aapl", security, row({}), 2_000)).toMatchObject({ price: 101, time: 1_000, previousClose: 99, session: "after_hours", venue: "US", regularPrice: 100, regularTime: 900 });
  });

  it("keeps the previous close as the regular price of a pre-market trade", () => {
    const pre = row({ currentTradingPeriod: { pre: { start: 950, end: 1_500 }, regular: { start: 1_500, end: 2_500 } } });
    expect(quoteFromSpark("sec-us-aapl", security, pre, 1_100)).toMatchObject({ price: 101, session: "pre_market", regularPrice: 100, regularTime: 900 });
  });

  it("has no regular price during the regular session", () => {
    const regular = row({ regularMarketTime: 1_000, regularMarketPrice: 101, currentTradingPeriod: { regular: { start: 500, end: 2_500 } } });
    const quote = quoteFromSpark("sec-us-aapl", security, regular, 1_100);
    expect(quote).toMatchObject({ price: 101, session: "regular" });
    expect(quote).not.toHaveProperty("regularPrice");
  });

  it("ignores an isolated bad tick", () => {
    expect(quoteFromSpark("sec-us-aapl", security, row({}, [10]), 2_000)).toMatchObject({ price: 100, time: 900 });
  });
});

describe("provider pages", () => {
  it("parses Yahoo! ファイナンス fund pages, NAV history and distributions", () => {
    expect(parseFundPage('x\\"priceBoard\\":{\\"code\\":\\"02311886\\",\\"name\\":\\"インデックスファンド225\\"},\\"jwtToken\\":\\"abc.def\\"')).toEqual({ token: "abc.def", name: "インデックスファンド225" });
    expect([...parseFundHistory({ priceHistories: [{ baseDate: "2026-10-05", closePrice: 20_115 }, { baseDate: "bad", closePrice: 1 }] })]).toEqual([["2026-10-05", 20_115]]);
    expect(parseFundDistributions('\\"date\\":\\"2026/9/25\\",\\"price\\":\\"130\\",\\"date\\":\\"2026/8/25\\",\\"price\\":\\"1,130\\"')).toEqual([{ date: "2026-08-25", amount: 1_130 }, { date: "2026-09-25", amount: 130 }]);
    expect(parseBlackRockDistributions({ table: { aaData: [[{ raw: 20260925 }, { raw: 130 }], [{ raw: "x" }, { raw: 1 }]] } })).toEqual([{ date: "2026-09-25", amount: 130 }]);
    expect([...parseMonexPage("var chartData = [{\"dt\":1791244800000,\"p\":12.5}];")]).toEqual([["2026-10-06", 12.5]]);
  });

  it("parses Japannext rows traded this session without evaluating the file", () => {
    const source = 'mdata[ 0 ] = [ "285A", "", "", "", "18800", "18900", "18700", "18850", "1200" ];\nmdata[ 1 ] = [ "7203", "", "", "", "", "", "", "3000", "0" ];\nalert(1);';
    expect([...parsePtsSource(source)]).toEqual([["285A", { price: 18_850, volume: 1_200 }]]);
  });

  it("knows the Japannext windows", () => {
    const night = { venue: "night", session: "pts_night", sessionKey: "2026-10-05", start: Date.parse("2026-10-05T08:00:00Z") / 1000 };
    expect(ptsWindowAt(Date.parse("2026-10-05T13:00:00Z"))).toEqual(night);
    expect(ptsWindowAt(Date.parse("2026-10-05T16:00:00Z"))).toEqual(night);
    expect(ptsWindowAt(Date.parse("2026-10-05T23:30:00Z"))).toEqual({ venue: "day", session: "pts_day", sessionKey: "2026-10-06", start: Date.parse("2026-10-05T23:20:00Z") / 1000 });
    expect(ptsWindowAt(Date.parse("2026-10-03T03:00:00Z"))).toBeNull();
  });

  it("parses the TOPIX board", () => {
    const now = Date.parse("2026-10-06T07:00:00Z") / 1000;
    expect(parseTopixPage('{"mainDomesticIndexPriceBoard":{"price":"3,000.5","changePriceRate":"+0.10","japanUpdateTime":"15:30"}}', now)).toEqual({
      id: "topix", label: "TOPIX", symbol: "998405.T", value: 3_000.5, changeRatio: 0.001, time: Date.parse("2026-10-06T06:30:00Z") / 1000,
    });
  });
});
