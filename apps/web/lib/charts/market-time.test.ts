import { describe, expect, it } from "vitest";
import { exchangeTimeZone, exchangeTimeZoneCode, marketDateKey, marketDateTimeLabel, marketTimeWithZoneLabel } from "./market-time";

describe("market time", () => {
  it("keys dates in the exchange time zone", () => {
    const beforeTokyoMidnight = "2026-08-12T14:30:00.000Z";
    const afterTokyoMidnight = "2026-08-12T15:30:00.000Z";
    expect(marketDateKey(beforeTokyoMidnight, "XNAS")).toBe("2026-08-12");
    expect(marketDateKey(afterTokyoMidnight, "XNAS")).toBe("2026-08-12");
    expect(marketDateKey(beforeTokyoMidnight, "XTKS")).toBe("2026-08-12");
    expect(marketDateKey(afterTokyoMidnight, "XTKS")).toBe("2026-08-13");
  });

  it("resolves exchange time zones from MIC, country or currency", () => {
    expect(exchangeTimeZone("ARCX", undefined, "JPY")).toBe("America/New_York");
    expect(exchangeTimeZone("XNAS", "Not/A_Timezone")).toBe("America/New_York");
    expect(exchangeTimeZone("JNX")).toBe("Asia/Tokyo");
    expect(exchangeTimeZone(undefined, undefined, "JPY", "US")).toBe("America/New_York");
    expect(exchangeTimeZone(undefined, undefined, "USD")).toBe("America/New_York");
    expect(exchangeTimeZone(undefined, undefined, "JPY")).toBe("Asia/Tokyo");
  });

  it("resolves time zone codes for major exchanges", () => {
    const summer = new Date("2026-07-01T12:00:00Z");
    const winter = new Date("2026-01-01T12:00:00Z");
    expect(exchangeTimeZoneCode(summer, "America/New_York")).toBe("EDT");
    expect(exchangeTimeZoneCode(winter, "America/New_York")).toBe("EST");
    expect(exchangeTimeZoneCode(summer, "Asia/Tokyo")).toBe("JST");
    expect(exchangeTimeZoneCode(summer, "Europe/London")).toBe("BST");
    expect(exchangeTimeZoneCode(winter, "Europe/Berlin")).toBe("CET");
  });

  it("formats native market times", () => {
    expect(marketDateTimeLabel("2026-09-15T09:44:00.000Z", "XNAS", undefined, "USD")).toBe("9/15 05:44 EDT");
    expect(marketDateTimeLabel("2026-09-15T06:00:00.000Z", "XTKS", undefined, "JPY")).toBe("9/15 15:00 JST");
    expect(marketTimeWithZoneLabel("2026-09-15T09:44:00.000Z", "XNAS", undefined, "USD")).toBe("05:44 EDT");
    expect(marketTimeWithZoneLabel("2026-09-15T06:00:00.000Z", "XTKS", undefined, "JPY")).toBe("15:00 JST");
  });
});
