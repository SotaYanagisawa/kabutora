import { describe, expect, it } from "vitest";
import { exchangeTimeZone, latestPlottedDate, marketDateKey, marketTimeLabel, sparseIntradayTimeTicks, trailingHours } from "./chart-presentation";

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
});
