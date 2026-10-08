import { describe, expect, it } from "vitest";
import { compactQuoteTime, compactSignedPercent, formatWidgetFetchedTime, quoteSessionLabel, quoteTradeSourceLabel } from "./helpers";
import type { DisplayQuote } from "./types";

describe("dashboard helpers", () => {
  describe("formatWidgetFetchedTime", () => {
    it("formats today's US stock market trade time in ET/EDT", () => {
      // 05:44 AM EDT on 2026-09-15
      const marketTimestamp = "2026-09-15T09:44:00.000Z";
      const fetchedAt = "2026-09-15T09:45:00.000Z";

      const formatted = formatWidgetFetchedTime(
        fetchedAt,
        marketTimestamp,
        "XNAS",
        "America/New_York",
        "USD",
        "US",
        new Date(fetchedAt),
      );

      // Should be formatted in native timezone (EDT or ET) and not Tokyo time (18:44)
      expect(formatted).toMatch(/05:44 (?:EDT|ET)/);
    });

    it("formats today's Japanese stock trade time in JST", () => {
      // 15:00 JST on 2026-09-15
      const marketTimestamp = "2026-09-15T06:00:00.000Z";
      const fetchedAt = "2026-09-15T06:01:00.000Z";

      const formatted = formatWidgetFetchedTime(
        fetchedAt,
        marketTimestamp,
        "XTKS",
        "Asia/Tokyo",
        "JPY",
        "JP",
        new Date(fetchedAt),
      );

      expect(formatted).toBe("15:00 JST");
    });

    it("formats older trade time with date, time, and native timezone", () => {
      // 2026-09-11 16:00 EDT (Friday close)
      const marketTimestamp = "2026-09-11T20:00:00.000Z";
      const fetchedAt = "2026-09-15T09:45:00.000Z";

      const formatted = formatWidgetFetchedTime(
        fetchedAt,
        marketTimestamp,
        "XNYS",
        "America/New_York",
        "USD",
        "US",
        new Date(fetchedAt),
      );

      expect(formatted).toBe("9/11 16:00 EDT");
    });

    it("falls back to fetchedAt if marketTimestamp is null", () => {
      const fetchedAt = "2026-09-11T20:00:00.000Z";
      const formatted = formatWidgetFetchedTime(
        fetchedAt,
        null,
        "XNYS",
        "America/New_York",
        "USD",
        "US",
        new Date("2026-09-15T09:45:00.000Z"),
      );

      expect(formatted).toBe("9/11 16:00 EDT");
    });

    it("returns null if neither timestamp is available", () => {
      expect(formatWidgetFetchedTime(null, null)).toBeNull();
    });
  });

  describe("card quote labels", () => {
    it("shows the time on the exchange's current day and only the date otherwise", () => {
      const now = Date.parse("2026-10-08T04:30:00Z"); // 13:30 JST, 00:30 EDT
      expect(compactQuoteTime("2026-10-08T03:00:00Z", "Asia/Tokyo", now)).toBe("12:00");
      expect(compactQuoteTime("2026-10-07T06:30:00Z", "Asia/Tokyo", now)).toBe("10/7");
      expect(compactQuoteTime("2026-10-07T20:00:00Z", "America/New_York", now)).toBe("10/7");
      expect(compactQuoteTime("2026-10-08T04:20:00Z", "America/New_York", now)).toBe("00:20");
      expect(compactQuoteTime(null, "Asia/Tokyo", now)).toBeNull();
      expect(compactQuoteTime("bad", "Asia/Tokyo", now)).toBeNull();
    });

    it("names the session a price comes from", () => {
      expect(quoteSessionLabel({ venueCode: "JNX", session: "pts_night" })).toBe("PTS");
      expect(quoteSessionLabel({ venueCode: "US", session: "after_hours" })).toBe("時間外");
      expect(quoteSessionLabel({ venueCode: "US", session: "pre_market" })).toBe("プレ");
      expect(quoteSessionLabel({ venueCode: "TSE", session: "regular" })).toBe("取引中");
      expect(quoteSessionLabel({ venueCode: "TSE", session: "closed" })).toBe("終値");
      expect(quoteSessionLabel({ venueCode: "FUND", session: "closed" })).toBe("基準価額");
    });

    it("drops decimals from returns of 100% and more", () => {
      expect(compactSignedPercent(0.1234)).toBe("+12.3%");
      expect(compactSignedPercent(0.999)).toBe("+99.9%");
      expect(compactSignedPercent(9.288)).toBe("+929%");
      expect(compactSignedPercent(11.567)).toBe("+1,157%");
      expect(compactSignedPercent(-0.5)).toBe("-50.0%");
      expect(compactSignedPercent(null)).toBe("—");
    });
  });

  describe("quoteTradeSourceLabel", () => {
    const baseQuote: Pick<DisplayQuote, "venueCode" | "session" | "priceType"> = {
      venueCode: "US",
      session: "regular",
      priceType: "last_trade",
    };

    it("labels pre-market trades correctly", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, session: "pre_market" })).toBe("プレ約定");
    });

    it("labels after-hours trades correctly", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, session: "after_hours" })).toBe("時間外約定");
    });

    it("labels official close correctly", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, session: "closed", priceType: "official_close" })).toBe("終値");
    });

    it("labels Tokyo official close as 東証終値", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, venueCode: "TSE", session: "closed", priceType: "official_close" })).toBe("東証終値");
    });

    it("labels PTS trades as PTS約定", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, venueCode: "JNX" })).toBe("PTS約定");
    });

    it("labels funds as 基準価額", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, venueCode: "FUND" })).toBe("基準価額");
    });

    it("labels indexes as 指数値", () => {
      expect(quoteTradeSourceLabel({ ...baseQuote, venueCode: "INDEX" })).toBe("指数値");
    });

    it("labels regular market trades as 最終約定", () => {
      expect(quoteTradeSourceLabel(baseQuote)).toBe("最終約定");
    });
  });
});
