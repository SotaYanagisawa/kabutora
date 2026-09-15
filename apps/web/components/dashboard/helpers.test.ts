import { describe, expect, it } from "vitest";
import { formatWidgetFetchedTime, quoteTradeSourceLabel } from "./helpers";
import type { MarketQuote } from "@kabutora/domain";

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
      );

      expect(formatted).toBe("9/11 16:00 EDT");
    });

    it("returns null if neither timestamp is available", () => {
      expect(formatWidgetFetchedTime(null, null)).toBeNull();
    });
  });

  describe("quoteTradeSourceLabel", () => {
    const baseQuote: MarketQuote = {
      price: "100",
      venueCode: "US",
      session: "regular",
      priceType: "last_trade",
      freshness: "live",
      provider: "test",
      marketTimestamp: "2026-09-15T09:44:00.000Z",
      fetchedAt: "2026-09-15T09:45:00.000Z",
      validationStatus: "valid",
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
