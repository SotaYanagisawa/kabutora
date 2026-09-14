import { describe, expect, it } from "vitest";
import {
  alignIntradayToQuote,
  exchangeTimeZone,
  latestIntradaySessionBars,
  latestPlottedDate,
  marketDateKey,
  marketSessionDateKey,
  marketTimeLabel,
  resolveSparklineSeries,
  sparkline24HourBars,
  sparseIntradayTimeTicks,
  trailingHours,
} from "./chart-presentation";

describe("chart presentation", () => {
  it("resolves the latest plotted Tokyo date", () => {
    const friday = [{ date: "2026-08-07T06:30:00.000Z" }];
    expect(latestPlottedDate(friday)).toBe("2026-08-07");
  });

  it("keeps exactly the trailing 24 hours from the latest plotted point", () => {
    const points = [
      { date: "2026-08-11T05:59:59.000Z", value: 1 },
      { date: "2026-08-11T06:00:00.000Z", value: 2 },
      { date: "2026-08-12T05:45:00.000Z", value: 3 },
      { date: "2026-08-12T06:00:00.000Z", value: 4 },
    ];
    expect(trailingHours(points, 24).map((point) => point.value)).toEqual([2, 3, 4]);
  });

  it("uses only the opening, midpoint, and latest times for a compact sparkline axis", () => {
    const points = ["09:00", "10:00", "11:00", "12:00", "13:00"].map((timestamp) => ({ timestamp }));
    expect(sparseIntradayTimeTicks(points)).toEqual(["09:00", "11:00", "13:00"]);
    expect(sparseIntradayTimeTicks(points.slice(0, 2))).toEqual(["09:00", "10:00"]);
  });

  it("keeps a US trading session together when Tokyo passes midnight", () => {
    const beforeTokyoMidnight = "2026-08-12T14:45:00.000Z";
    const afterTokyoMidnight = "2026-08-12T15:15:00.000Z";

    expect(marketDateKey(beforeTokyoMidnight, "XNAS")).toBe("2026-08-12");
    expect(marketDateKey(afterTokyoMidnight, "XNAS")).toBe("2026-08-12");
    expect(marketDateKey(beforeTokyoMidnight, "XTKS")).toBe("2026-08-12");
    expect(marketDateKey(afterTokyoMidnight, "XTKS")).toBe("2026-08-13");
    expect(marketTimeLabel(beforeTokyoMidnight, "XNAS")).toBe("10:45");
    expect(marketTimeLabel(afterTokyoMidnight, "XNAS")).toBe("11:15");
  });

  it("resolves US exchanges (ARCX, XAMS, XNAS, NYSE) to New York even with JPY currency", () => {
    expect(exchangeTimeZone("ARCX", undefined, "JPY")).toBe("America/New_York");
    expect(exchangeTimeZone("XAMS", undefined, "JPY")).toBe("America/New_York");
    expect(exchangeTimeZone("XNAS", undefined, "JPY")).toBe("America/New_York");
    expect(exchangeTimeZone("XNYS", undefined, "JPY")).toBe("America/New_York");
    expect(exchangeTimeZone(undefined, undefined, "JPY", "US")).toBe("America/New_York");
    expect(exchangeTimeZone(undefined, undefined, "JPY", "JP")).toBe("Asia/Tokyo");

    // Quote timestamp around 3:30 PM EDT (19:30 UTC) formats as 15:30 in New York
    const quoteTimestamp = "2026-09-02T19:30:00.000Z";
    expect(marketTimeLabel(quoteTimestamp, "ARCX", undefined, "JPY")).toBe("15:30");
    expect(marketTimeLabel(quoteTimestamp, "XAMS", undefined, "JPY")).toBe("15:30");
    expect(marketTimeLabel(quoteTimestamp, undefined, undefined, "JPY", "US")).toBe("15:30");
    expect(marketDateKey(quoteTimestamp, "ARCX", undefined, "JPY")).toBe("2026-09-02");
  });

  it("aligns a matching quote without discarding newer extended-hours bars", () => {
    const bars = [
      { securityId: "sec-us-aapl", timestamp: "2026-09-02T13:30:00.000Z", price: "220", provider: "yahoo" },
      { securityId: "sec-us-aapl", timestamp: "2026-09-02T15:00:00.000Z", price: "225", provider: "yahoo" },
      { securityId: "sec-us-aapl", timestamp: "2026-09-02T19:00:00.000Z", price: "228", provider: "yahoo" },
      { securityId: "sec-us-aapl", timestamp: "2026-09-02T20:00:00.000Z", price: "230", provider: "yahoo" },
    ];

    // A regular-session quote at 15:30 EDT must not discard the later
    // after-hours observation at 16:00 EDT.
    const aligned = alignIntradayToQuote(bars, "2026-09-02T19:30:00.000Z", 229, "sec-us-aapl");
    expect(aligned).toHaveLength(4);
    expect(aligned.at(-1)).toEqual({
      securityId: "sec-us-aapl",
      timestamp: "2026-09-02T20:00:00.000Z",
      price: "230",
      provider: "yahoo",
    });

    // When quote timestamp exactly matches the last bar, update its price to the latest quote price
    const matched = alignIntradayToQuote(aligned, "2026-09-02T20:00:00.000Z", 229.5, "sec-us-aapl");
    expect(matched).toHaveLength(4);
    expect(matched.at(-1)?.price).toBe("229.5");

    // When bars is empty, synthesizes a single point at the quote timestamp
    const fromEmpty = alignIntradayToQuote([], "2026-09-02T19:30:00.000Z", 229, "sec-us-aapl");
    expect(fromEmpty).toHaveLength(1);
    expect(fromEmpty[0].price).toBe("229");
  });

  it("limits a long session while preserving the opening, closing, low, and high", () => {
    const bars = Array.from({ length: 600 }, (_, index) => ({
      securityId: "sec-us-aapl",
      timestamp: new Date(Date.UTC(2026, 8, 8, 8, index)).toISOString(),
      price: String(index === 123 ? 50 : index === 456 ? 250 : 100 + index / 100),
      provider: "synthetic",
    }));
    const selected = latestIntradaySessionBars(bars, "XNAS", undefined, "USD", "US");
    expect(selected.length).toBeLessThanOrEqual(256);
    expect(selected[0]).toEqual(bars[0]);
    expect(selected.at(-1)).toEqual(bars.at(-1));
    expect(selected.some((bar) => bar.price === "50")).toBe(true);
    expect(selected.some((bar) => bar.price === "250")).toBe(true);
  });

  it("is independent of the device timezone across worldwide travel locations", () => {
    const originalTimeZone = process.env.TZ;
    const testLocations = [
      "Pacific/Honolulu",   // UTC-10
      "America/Los_Angeles",// UTC-7
      "America/New_York",   // UTC-4
      "Europe/London",      // UTC+1
      "Europe/Paris",       // UTC+2
      "Asia/Dubai",         // UTC+4
      "Asia/Bangkok",       // UTC+7
      "Asia/Tokyo",         // UTC+9
      "Australia/Sydney",   // UTC+10
      "Pacific/Auckland",   // UTC+12
      "UTC",
    ];

    try {
      for (const timeZone of testLocations) {
        process.env.TZ = timeZone;

        // US Stock (e.g. AAPL) during New York trading hours
        // 2026-08-12T15:15:00.000Z = 11:15 AM EDT
        expect(marketDateKey("2026-08-12T15:15:00.000Z", "XNAS", undefined, "USD")).toBe("2026-08-12");
        expect(marketTimeLabel("2026-08-12T15:15:00.000Z", "XNAS", undefined, "USD")).toBe("11:15");

        // JP Stock (e.g. 7203 Toyota) during Tokyo trading hours
        // 2026-08-12T06:00:00.000Z = 15:00 JST
        expect(marketDateKey("2026-08-12T06:00:00.000Z", "XTKS", undefined, "JPY")).toBe("2026-08-12");
        expect(marketTimeLabel("2026-08-12T06:00:00.000Z", "XTKS", undefined, "JPY")).toBe("15:00");

        // Investment trust (JPY)
        expect(marketDateKey("2026-08-12T11:00:00.000Z", "FUND", undefined, "JPY")).toBe("2026-08-12");
        expect(marketTimeLabel("2026-08-12T11:00:00.000Z", "FUND", undefined, "JPY")).toBe("20:00");
      }

      expect(exchangeTimeZone("XNAS", "Not/A_Timezone")).toBe("America/New_York");
      expect(exchangeTimeZone("XNYS")).toBe("America/New_York");
      expect(exchangeTimeZone("XTKS")).toBe("Asia/Tokyo");
      expect(exchangeTimeZone("JNX")).toBe("Asia/Tokyo");
      expect(exchangeTimeZone(undefined, undefined, "JPY")).toBe("Asia/Tokyo");
      expect(exchangeTimeZone(undefined, undefined, "USD")).toBe("America/New_York");
    } finally {
      process.env.TZ = originalTimeZone;
    }
  });

  describe("resolveSparklineSeries", () => {
    it("Tier 1: resolves to intraday_session when current session has >= 3 bars", () => {
      const bars = [
        { securityId: "7203.T", timestamp: "2026-09-04T00:00:00.000Z", price: "3000", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T01:00:00.000Z", price: "3020", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T02:00:00.000Z", price: "3010", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T05:00:00.000Z", price: "3050", provider: "yahoo" },
      ];
      const res = resolveSparklineSeries({
        bars,
        previousClose: 2990,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
      });
      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.values).toHaveLength(4);
        expect(res.previousClose).toBe(2990);
        expect(res.previousY).not.toBeNull();
        expect(res.points.split(" ")).toHaveLength(4);
      }
    });

    it("Tier 1: resolves to intraday_session for 2 points in the same session (e.g. TSE close + PTS trade)", () => {
      const twoBars = [
        { securityId: "7203.T", timestamp: "2026-09-04T06:00:00.000Z", price: "3090", provider: "yahoo_japan_html" },
        { securityId: "7203.T", timestamp: "2026-09-04T10:00:00.000Z", price: "3100", provider: "yahoo_japan_pts_html" },
      ];
      const dailyBars = [
        { securityId: "7203.T", date: "2026-08-10", close: "3000", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-08-20", close: "3050", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-09-04", close: "3090", provider: "yahoo" },
      ];
      const res = resolveSparklineSeries({
        bars: twoBars,
        dailyBars,
        previousClose: 3080,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
      });
      // Strictly single-session intraday (one day max) with previousClose scaling; never falls back to 1M daily!
      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.values).toEqual([3090, 3100]);
        expect(res.previousClose).toBe(3080);
        expect(res.previousY).not.toBeNull();
        expect(res.timeLabels).toEqual(["15:00", "19:00"]);
      }
    });

    it("shows the newest session immediately when its first real price point arrives, and uses previous session before that", () => {
      // 4 bars from yesterday
      const yesterdayBars = [
        { securityId: "7203.T", timestamp: "2026-09-03T01:00:00.000Z", price: "2980", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-03T02:00:00.000Z", price: "2990", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-03T03:00:00.000Z", price: "3000", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-03T05:00:00.000Z", price: "3010", provider: "yahoo" },
      ];
      // 1 bar from today
      const todayBar = { securityId: "7203.T", timestamp: "2026-09-04T00:05:00.000Z", price: "3020", provider: "yahoo" };

      // Before any new-session data exists: show previous completed session without visible label
      const beforeToday = resolveSparklineSeries({
        bars: yesterdayBars,
        previousClose: 3010,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
        currentTime: "2026-09-04T00:00:00.000Z",
      });
      expect(beforeToday.kind).toBe("intraday_session");
      if (beforeToday.kind === "intraday_session") {
        expect(beforeToday.values).toEqual([2980, 2990, 3000, 3010]);
        expect(beforeToday.timeLabels).toEqual(["10:00", "11:00", "14:00"]);
        expect(beforeToday.isPreviousSession).toBe(true);
        expect(beforeToday.sessionLabel).toBeNull();
        expect(beforeToday.sessionDate).toBe("2026-09-03");
        expect(beforeToday.previousClose).toBeNull();
        expect(beforeToday.previousY).toBeNull();
      }

      // When first price point arrives within the trailing 24h window: retains 24-hour context including today's observation
      const withToday = resolveSparklineSeries({
        bars: [...yesterdayBars, todayBar],
        previousClose: 3010,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
        currentTime: "2026-09-04T00:05:00.000Z",
      });
      expect(withToday.kind).toBe("intraday_session");
      if (withToday.kind === "intraday_session") {
        expect(withToday.values).toHaveLength(5);
        expect(withToday.values.at(-1)).toBe(3020);
        expect(withToday.sessionDate).toBe("2026-09-04");
        expect(withToday.isPreviousSession).toBe(false);
      }

      // When a single observation exists with no other bars in 24 hours: shows single point
      const solitary = resolveSparklineSeries({
        bars: [todayBar],
        previousClose: 3010,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
        currentTime: "2026-09-04T00:05:00.000Z",
      });
      expect(solitary.kind).toBe("intraday_single");
      if (solitary.kind === "intraday_single") {
        expect(solitary.values).toEqual([3020]);
        expect(solitary.sessionDate).toBe("2026-09-04");
        expect(solitary.isPreviousSession).toBe(false);
        expect(solitary.timeLabels).toEqual(["09:05"]);
      }
    });

    it("switches to today's US pre-market immediately on first point and to curve on second", () => {
      const yesterday = [
        { securityId: "sec-us-aapl", timestamp: "2026-09-09T13:30:00.000Z", price: "230", provider: "yahoo" },
        { securityId: "sec-us-aapl", timestamp: "2026-09-09T20:00:00.000Z", price: "232", provider: "yahoo" },
      ];
      const oneToday = { securityId: "sec-us-aapl", timestamp: "2026-09-10T13:22:00.000Z", price: "233", provider: "quote" };
      const twoToday = { securityId: "sec-us-aapl", timestamp: "2026-09-10T13:23:00.000Z", price: "234", provider: "yahoo" };

      // Before today's points: previous session is selected
      const before = resolveSparklineSeries({
        bars: yesterday,
        previousClose: 232,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-10T13:00:00.000Z",
      });
      expect(before.kind).toBe("intraday_session");
      if (before.kind === "intraday_session") {
        expect(before.values).toEqual([230, 232]);
        expect(before.isPreviousSession).toBe(true);
        expect(before.sessionLabel).toBeNull();
      }

      // When a single observation exists with no other bars in 24 hours: shows single point
      const solitaryUs = resolveSparklineSeries({
        bars: [oneToday],
        previousClose: 232,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-10T13:22:00.000Z",
      });
      expect(solitaryUs.kind).toBe("intraday_single");
      if (solitaryUs.kind === "intraday_single") {
        expect(solitaryUs.values).toEqual([233]);
        expect(solitaryUs.isPreviousSession).toBe(false);
      }

      // When points exist across the trailing 24 hours: renders the full 24-hour curve
      const trailing24 = resolveSparklineSeries({
        bars: [...yesterday, oneToday],
        previousClose: 232,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-10T13:22:00.000Z",
      });
      expect(trailing24.kind).toBe("intraday_session");
      if (trailing24.kind === "intraday_session") {
        expect(trailing24.values).toEqual([230, 232, 233]);
        expect(trailing24.isPreviousSession).toBe(false);
      }

      // Second point arrives: curve for today
      const current = resolveSparklineSeries({
        bars: [...yesterday, oneToday, twoToday],
        previousClose: 232,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-10T13:25:00.000Z",
      });
      expect(current.kind).toBe("intraday_session");
      if (current.kind === "intraday_session") {
        expect(current.values).toEqual([230, 232, 233, 234]);
        expect(current.isPreviousSession).toBe(false);
        expect(current.sessionLabel).toBeNull();
        expect(current.previousClose).toBe(232);
      }
    });

    it("ensures a week-old curve does not override a single fresh point", () => {
      const weekOldBars = [
        { securityId: "sec-us-msft", timestamp: "2026-09-04T13:30:00.000Z", price: "400", provider: "yahoo" },
        { securityId: "sec-us-msft", timestamp: "2026-09-04T20:00:00.000Z", price: "405", provider: "yahoo" },
      ];
      const freshPoint = { securityId: "sec-us-msft", timestamp: "2026-09-11T13:35:00.000Z", price: "410", provider: "quote" };

      const res = resolveSparklineSeries({
        bars: [...weekOldBars, freshPoint],
        previousClose: 405,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-11T14:00:00.000Z",
      });

      expect(res.kind).toBe("intraday_single");
      if (res.kind === "intraday_single") {
        expect(res.values).toEqual([410]);
        expect(res.sessionDate).toBe("2026-09-11");
        expect(res.isPreviousSession).toBe(false);
      }
    });

    it("does not allow an older quote timestamp to move the chart backward", () => {
      const todayBars = [
        { securityId: "sec-us-nvda", timestamp: "2026-09-11T13:30:00.000Z", price: "120", provider: "yahoo" },
        { securityId: "sec-us-nvda", timestamp: "2026-09-11T13:45:00.000Z", price: "122", provider: "yahoo" },
      ];
      // Quote timestamp is from yesterday
      const oldQuoteTimestamp = "2026-09-10T20:00:00.000Z";

      const res = resolveSparklineSeries({
        bars: todayBars,
        asOf: oldQuoteTimestamp,
        currentTime: "2026-09-11T14:00:00.000Z",
        previousClose: 118,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
      });

      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.sessionDate).toBe("2026-09-11");
        expect(res.isPreviousSession).toBe(false);
        expect(res.values).toEqual([120, 122]);
      }
    });

    it("returns empty when neither eligible session has data, preventing arbitrarily old curves", () => {
      const twoWeeksOldBars = [
        { securityId: "sec-us-amzn", timestamp: "2026-08-28T13:30:00.000Z", price: "170", provider: "yahoo" },
        { securityId: "sec-us-amzn", timestamp: "2026-08-28T20:00:00.000Z", price: "175", provider: "yahoo" },
      ];

      const res = resolveSparklineSeries({
        bars: twoWeeksOldBars,
        previousClose: 175,
        exchangeMic: "XNAS",
        stockCurrency: "USD",
        currentTime: "2026-09-11T14:00:00.000Z",
      });

      // Neither 2026-09-11 nor 2026-09-10 has data
      expect(res.kind).toBe("empty");
    });

    it("accepts two equal-price observations as a real flat session", () => {
      const res = resolveSparklineSeries({
        bars: [
          { securityId: "sec-us-spy", timestamp: "2026-09-10T08:00:00.000Z", price: "650", provider: "yahoo" },
          { securityId: "sec-us-spy", timestamp: "2026-09-10T08:05:00.000Z", price: "650", provider: "yahoo" },
        ],
        exchangeMic: "ARCX",
        stockCurrency: "USD",
      });
      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") expect(res.values).toEqual([650, 650]);
    });

    it("does not substitute daily history for a sparse intraday session", () => {
      const singleQuoteBar = [
        { securityId: "7203.T", timestamp: "2026-09-04T06:00:00.000Z", price: "3090", provider: "yahoo_japan_html" },
      ];
      const dailyBars = [
        { securityId: "7203.T", date: "2026-08-10", close: "3000", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-08-15", close: "3020", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-08-20", close: "3050", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-09-01", close: "3080", provider: "yahoo" },
        { securityId: "7203.T", date: "2026-09-04", close: "3090", provider: "yahoo" },
      ];
      const res = resolveSparklineSeries({
        bars: singleQuoteBar,
        dailyBars,
        previousClose: 3080,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
      });
      expect(res.kind).toBe("intraday_single");
      if (res.kind === "intraday_single") {
        expect(res.values).toEqual([3090]);
        expect(res.timeLabels).toEqual(["15:00"]);
      }
    });

    it("shows a single real observation without fabricating a previous-close line", () => {
      const singleQuoteBar = [
        { securityId: "new-stock", timestamp: "2026-09-04T06:00:00.000Z", price: "100", provider: "quote" },
      ];
      const res = resolveSparklineSeries({
        bars: singleQuoteBar,
        dailyBars: [],
        previousClose: 95,
        exchangeMic: "XTKS",
      });
      expect(res.kind).toBe("intraday_single");
      if (res.kind === "intraday_single") {
        expect(res.values).toEqual([100]);
        expect(res.previousClose).toBeNull();
        expect(res.points.split(" ")).toHaveLength(1);
        expect(res.timeLabels).toEqual(["15:00"]);
      }
    });

    it("returns empty when no bars exist", () => {
      const res = resolveSparklineSeries({
        bars: [],
        dailyBars: [],
      });
      expect(res.kind).toBe("empty");
    });

    it("does not collapse daytime bars into a straight line when ticker has an overnight PTS trade after midnight", () => {
      // 24 daytime TSE bars on Friday 2026-09-04 (09:00 - 15:30 JST = 00:00 - 06:30 UTC)
      const daytimeBars = [
        { securityId: "7203.T", timestamp: "2026-09-04T00:00:00.000Z", price: "3000", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T01:00:00.000Z", price: "3020", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T02:00:00.000Z", price: "3030", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T06:30:00.000Z", price: "3081", provider: "yahoo" },
      ];
      // 1 overnight Japannext PTS trade on Saturday 01:30 JST (Friday 16:30 UTC)
      const ptsOvernightBar = {
        securityId: "7203.T",
        timestamp: "2026-09-04T16:30:00.000Z", // 01:30 JST Saturday
        price: "3080",
        provider: "yahoo_japan_pts_html",
      };
      const allBars = [...daytimeBars, ptsOvernightBar];

      const res = resolveSparklineSeries({
        bars: allBars,
        previousClose: 2990,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
      });

      // Must remain intraday_session with all 5 points, NOT collapse to minimal 2-point straight line!
      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.values).toHaveLength(5);
        expect(res.values).toEqual([3000, 3020, 3030, 3081, 3080]);
        expect(res.timeLabels).toEqual(["09:00", "11:00", "01:30"]);
      }
    });

    it("does not collapse daytime bars when aligned with a weekend TSE close quote", () => {
      const daytimeBars = [
        { securityId: "7203.T", timestamp: "2026-09-04T00:00:00.000Z", price: "3000", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T03:00:00.000Z", price: "3040", provider: "yahoo" },
        { securityId: "7203.T", timestamp: "2026-09-04T06:30:00.000Z", price: "3081", provider: "yahoo" },
      ];
      // On weekend, quote timestamp is Friday TSE close 15:30 JST (06:30 UTC)
      const quoteTimestamp = "2026-09-04T06:30:00.000Z";
      const aligned = alignIntradayToQuote(daytimeBars, quoteTimestamp, 3081, "7203.T");

      const res = resolveSparklineSeries({
        bars: aligned,
        previousClose: 2990,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
      });

      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.values).toEqual([3000, 3040, 3081]);
      }
    });

    it("correctly resolves sparkline series for 285A (Kioxia) with daytime bars and night PTS bar", () => {
      const kioxiaBars = [
        { securityId: "sec-285a", timestamp: "2026-09-04T00:00:00.000Z", price: "52000", provider: "yahoo" },
        { securityId: "sec-285a", timestamp: "2026-09-04T01:00:00.000Z", price: "53000", provider: "yahoo" },
        { securityId: "sec-285a", timestamp: "2026-09-04T06:00:00.000Z", price: "54670", provider: "yahoo" },
        { securityId: "sec-285a", timestamp: "2026-09-04T06:30:00.000Z", price: "54460", provider: "yahoo" },
        { securityId: "sec-285a", timestamp: "2026-09-04T19:59:00.000Z", price: "57950", provider: "yahoo_japan_pts_html" },
      ];
      const quoteTimestamp = "2026-09-04T19:59:00.000Z";
      const aligned = alignIntradayToQuote(kioxiaBars, quoteTimestamp, "57950", "sec-285a", "yahoo_japan_pts_html");

      const res = resolveSparklineSeries({
        bars: aligned,
        previousClose: 51670,
        exchangeMic: "XTKS",
        stockCurrency: "JPY",
        country: "JP",
      });

      expect(res.kind).toBe("intraday_session");
      if (res.kind === "intraday_session") {
        expect(res.values).toEqual([52000, 53000, 54670, 54460, 57950]);
        expect(res.points.split(" ")).toHaveLength(5);
      }
    });
  });

  describe("marketSessionDateKey", () => {
    it("groups Friday TSE daytime, evening PTS, overnight post-midnight PTS, and weekend into Friday session", () => {
      // Friday 14:00 JST
      expect(marketSessionDateKey("2026-09-04T05:00:00.000Z", "XTKS")).toBe("2026-09-04");
      // Friday 21:00 JST
      expect(marketSessionDateKey("2026-09-04T12:00:00.000Z", "XTKS")).toBe("2026-09-04");
      // Saturday 01:30 JST (Friday night PTS after midnight)
      expect(marketSessionDateKey("2026-09-04T16:30:00.000Z", "XTKS")).toBe("2026-09-04");
      // Saturday 15:00 JST (Weekend)
      expect(marketSessionDateKey("2026-09-05T06:00:00.000Z", "XTKS")).toBe("2026-09-04");
      // Sunday 12:00 JST (Weekend)
      expect(marketSessionDateKey("2026-09-06T03:00:00.000Z", "XTKS")).toBe("2026-09-04");
    });

    it("treats Monday morning 08:30 JST onwards as Monday session", () => {
      // Monday 08:30 JST (PTS day)
      expect(marketSessionDateKey("2026-09-06T23:30:00.000Z", "XTKS")).toBe("2026-09-07");
      // Monday 09:05 JST (TSE open)
      expect(marketSessionDateKey("2026-09-07T00:05:00.000Z", "XTKS")).toBe("2026-09-07");
      // Tuesday 01:00 JST (Monday night PTS after midnight)
      expect(marketSessionDateKey("2026-09-07T16:00:00.000Z", "XTKS")).toBe("2026-09-07");
    });
  });

  describe("sparkline24HourBars (24-hour trailing window rule)", () => {
    it("when market is open: shows bars within 24 hours before current time", () => {
      const now = new Date("2026-09-11T18:00:00.000Z"); // Friday 14:00 ET (regular market is OPEN)
      const bars = [
        { securityId: "sec-us-aapl", timestamp: "2026-09-10T17:59:00.000Z", price: "220", provider: "test" }, // 24h 1m ago -> excluded
        { securityId: "sec-us-aapl", timestamp: "2026-09-10T18:01:00.000Z", price: "221", provider: "test" }, // 23h 59m ago -> included
        { securityId: "sec-us-aapl", timestamp: "2026-09-11T14:00:00.000Z", price: "225", provider: "test" }, // today -> included
        { securityId: "sec-us-aapl", timestamp: "2026-09-11T17:55:00.000Z", price: "228", provider: "test" }, // today -> included
      ];
      const result = sparkline24HourBars(bars, {
        now,
        isMarketOpen: true,
        exchangeMic: "XNAS",
        currency: "USD",
        country: "US",
      });
      expect(result.map((b) => b.price)).toEqual(["221", "225", "228"]);
    });

    it("when market is closed: shows the most recent market open time as last time, and 24 hours before that", () => {
      // Over the weekend (Sunday Sep 13, 2026): market is CLOSED
      const now = new Date("2026-09-13T12:00:00.000Z");
      const bars = [
        { securityId: "sec-us-nvda", timestamp: "2026-09-10T19:00:00.000Z", price: "100", provider: "test" }, // Thursday 15:00 ET -> excluded (>24h before Friday 20:00)
        { securityId: "sec-us-nvda", timestamp: "2026-09-10T20:30:00.000Z", price: "102", provider: "test" }, // Thursday 16:30 ET -> included (within 24h of Friday 20:00)
        { securityId: "sec-us-nvda", timestamp: "2026-09-11T13:30:00.000Z", price: "108", provider: "test" }, // Friday 09:30 ET open -> included
        { securityId: "sec-us-nvda", timestamp: "2026-09-11T20:00:00.000Z", price: "110", provider: "test" }, // Friday 16:00 ET close -> included (most recent market time)
      ];
      const result = sparkline24HourBars(bars, {
        now,
        isMarketOpen: false,
        exchangeMic: "XNAS",
        currency: "USD",
        country: "US",
      });
      // The last time in the sparkline is Friday 20:00 ET (the latest available market bar), and 24h before that
      expect(result.map((b) => b.price)).toEqual(["102", "108", "110"]);
      expect(result.at(-1)?.timestamp).toBe("2026-09-11T20:00:00.000Z");
    });

    it("applies the 24-hour trailing window universally to Japanese stocks", () => {
      // Saturday morning in Tokyo: market is CLOSED
      const now = new Date("2026-09-12T02:00:00.000Z"); // Saturday 11:00 JST
      const bars = [
        { securityId: "7203.T", timestamp: "2026-09-10T05:00:00.000Z", price: "3000", provider: "test" }, // Thursday -> excluded
        { securityId: "7203.T", timestamp: "2026-09-11T00:30:00.000Z", price: "3050", provider: "test" }, // Friday morning -> included
        { securityId: "7203.T", timestamp: "2026-09-11T06:00:00.000Z", price: "3080", provider: "test" }, // Friday TSE close -> included
        { securityId: "7203.T", timestamp: "2026-09-11T11:00:00.000Z", price: "3090", provider: "test" }, // Friday night PTS -> included
      ];
      const result = sparkline24HourBars(bars, {
        now,
        isMarketOpen: false,
        exchangeMic: "XTKS",
        currency: "JPY",
        country: "JP",
      });
      expect(result.map((b) => b.price)).toEqual(["3050", "3080", "3090"]);
      expect(result.at(-1)?.timestamp).toBe("2026-09-11T11:00:00.000Z");
    });
  });
});
