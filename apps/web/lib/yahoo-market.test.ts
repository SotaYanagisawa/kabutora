import { afterEach, describe, expect, it, vi } from "vitest";
import { tokyoMarketTimestamp } from "./yahoo-market";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Yahoo daily history adapter", () => {
  it("normalizes long histories and event dates across Tokyo midnight without per-row formatters", async () => {
    const start = Date.parse("2020-01-01T14:59:00Z") / 1000;
    const timestamp = [start, start + 60, ...Array.from({ length: 2500 }, (_, index) => start + (index + 1) * 86400)];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ chart: { result: [{
      meta: { firstTradeDate: start }, timestamp,
      indicators: { quote: [{ close: timestamp.map(() => 100) }] },
      events: { dividends: { event: { date: start + 60, amount: 1 } }, splits: { event: { date: start + 60, numerator: 2, denominator: 1 } } },
    }] } })));
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const { getYahooHistory } = await import("./yahoo-market");
      const history = await getYahooHistory("DATE-TEST", "sec-date-test", start, start + 2600 * 86400, true);
      expect(history.bars).toHaveLength(timestamp.length);
      expect(history.bars.slice(0, 2).map((bar) => bar.date)).toEqual(["2020-01-01", "2020-01-02"]);
      expect(history.corporateActions[0].effectiveDate).toBe("2020-01-02");
      expect(history.distributions[0].exDate).toBe("2020-01-02");
      expect(formatter).not.toHaveBeenCalled();
    } finally { formatter.mockRestore(); }
  });
  it("normalizes Yahoo cash dividends from the existing daily-history response", async () => {
    const timestamp = Math.floor(new Date("2026-03-10T06:00:00Z").getTime() / 1000);
    const payload = {
      chart: {
        result: [{
          meta: { currency: "USD", firstTradeDate: timestamp - 86_400 },
          timestamp: [timestamp],
          indicators: { quote: [{ close: [100] }], adjclose: [{ adjclose: [99] }] },
          events: { dividends: { [timestamp]: { date: timestamp, amount: 1.25 } } },
        }],
        error: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));

    const result = await (await import("./yahoo-market")).getYahooHistory("AAPL", "sec-aapl", timestamp - 86_400, timestamp + 86_400, true);

    expect(result.distributions).toEqual([expect.objectContaining({
      id: `sec-aapl-cash_dividend-${timestamp}`,
      securityId: "sec-aapl",
      type: "CASH_DIVIDEND",
      exDate: "2026-03-10",
      amountPerUnit: "1.25",
      distributionUnit: "1",
      currency: "USD",
      confidence: "reported",
    })]);
  });

  describe("tokyoMarketTimestamp", () => {
    it("preserves today's date during or after market session when updateTime has passed", () => {
      // Friday 2026-09-04 15:35:00 JST
      const now = new Date("2026-09-04T06:35:00.000Z");
      expect(tokyoMarketTimestamp("15:30", now)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("rolls back weekend to Friday close instead of stamping Saturday or Sunday", () => {
      // Saturday 2026-09-05 12:00:00 JST
      const saturday = new Date("2026-09-05T03:00:00.000Z");
      expect(tokyoMarketTimestamp("15:30", saturday)).toBe("2026-09-04T06:30:00.000Z");

      // Sunday 2026-09-06 12:00:00 JST
      const sunday = new Date("2026-09-06T03:00:00.000Z");
      expect(tokyoMarketTimestamp("15:30", sunday)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("rolls back Monday morning before market close to Friday close (preventing future timestamps)", () => {
      // Monday 2026-09-07 08:30:00 JST (before market open, quote says 15:30)
      const mondayMorning = new Date("2026-09-06T23:30:00.000Z");
      expect(tokyoMarketTimestamp("15:30", mondayMorning)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("assigns Monday date when current time is after the trade time on Monday", () => {
      // Monday 2026-09-07 09:15:00 JST (after 09:10 trade)
      const mondayTrading = new Date("2026-09-07T00:15:00.000Z");
      expect(tokyoMarketTimestamp("09:10", mondayTrading)).toBe("2026-09-07T00:10:00.000Z");
    });

    it("parses M/D format (such as 9/4) on weekends to TSE close 15:30 JST without returning now", () => {
      // Saturday 2026-09-05 10:00:00 JST
      const saturday = new Date("2026-09-05T01:00:00.000Z");
      expect(tokyoMarketTimestamp("9/4", saturday)).toBe("2026-09-04T06:30:00.000Z");
      expect(tokyoMarketTimestamp("09/04", saturday)).toBe("2026-09-04T06:30:00.000Z");
    });

    it("parses M/D H:mm format to exact Tokyo timestamp", () => {
      const saturday = new Date("2026-09-05T01:00:00.000Z");
      expect(tokyoMarketTimestamp("9/4 15:30", saturday)).toBe("2026-09-04T06:30:00.000Z");
    });
  });
});
