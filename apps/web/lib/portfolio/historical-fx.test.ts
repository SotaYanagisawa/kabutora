import { describe, expect, it } from "vitest";
import { historicalFxRateAtDate, historicalFxRateAtTimestamp, lookupFxRate } from "./historical-fx";
import { convertAmount, validUsdJpy } from "./money-conversion";

const bars = [
  { securityId: "sec-fx-usdjpy", date: "2025-01-02", close: "150", provider: "fixture" },
  { securityId: "sec-fx-usdjpy", date: "2025-01-06", close: "152", provider: "fixture" },
];

const intradayBars = [
  { securityId: "sec-fx-usdjpy", timestamp: "2025-01-06T14:00:00Z", price: "152.0", provider: "fixture" },
  { securityId: "sec-fx-usdjpy", timestamp: "2025-01-06T14:30:00Z", price: "151.0", provider: "fixture" },
  { securityId: "sec-fx-usdjpy", timestamp: "2025-01-06T15:00:00Z", price: "148.0", provider: "fixture" },
  { securityId: "sec-fx-usdjpy", timestamp: "2025-01-06T15:30:00Z", price: "145.0", provider: "fixture" },
];

describe("historical FX lookup", () => {
  it("carries the last historical rate across non-trading days", () => {
    expect(historicalFxRateAtDate(bars, "2025-01-05", 160)).toBe(150);
  });

  it("never substitutes today's rate for a transaction before cached history", () => {
    expect(historicalFxRateAtDate(bars, "2024-12-01", 160)).toBeNull();
  });

  it("uses the current rate only after the latest completed historical point", () => {
    expect(historicalFxRateAtDate(bars, "2025-01-07", 160)).toBe(160);
  });

  it("prefers live current rate when date is today even if daily bar close is present", () => {
    expect(historicalFxRateAtDate(bars, "2025-01-06", 145, false, "2025-01-06")).toBe(145);
    expect(historicalFxRateAtDate(bars, "2025-01-02", 145, false, "2025-01-06")).toBe(150);
  });

  it("safely falls back to earliest rate or current rate when fallbackToEarliest is enabled", () => {
    expect(historicalFxRateAtDate(bars, "2024-12-01", 160, true)).toBe(150);
    expect(historicalFxRateAtDate([], "2024-12-01", 160, true)).toBe(160);
  });
});
describe("historical FX lookup by timestamp (intraday)", () => {
  it("finds the exact matching intraday FX bar", () => {
    expect(historicalFxRateAtTimestamp(intradayBars, bars, "2025-01-06T15:00:00Z", 144)).toBe(148);
  });

  it("finds the nearest preceding intraday FX bar when between intervals", () => {
    expect(historicalFxRateAtTimestamp(intradayBars, bars, "2025-01-06T15:15:00Z", 144)).toBe(148);
    expect(historicalFxRateAtTimestamp(intradayBars, bars, "2025-01-06T15:25:00Z", 144)).toBe(148);
  });

  it("uses current rate when timestamp is after latest intraday bar", () => {
    expect(historicalFxRateAtTimestamp(intradayBars, bars, "2025-01-06T16:00:00Z", 143.5)).toBe(143.5);
  });

  it("falls back to daily history when timestamp precedes intraday window", () => {
    expect(historicalFxRateAtTimestamp(intradayBars, bars, "2025-01-02T10:00:00Z", 144)).toBe(150);
  });

  it("lookupFxRate routes transparently between dates and timestamps", () => {
    expect(lookupFxRate({ dateOrTimestamp: "2025-01-06T14:30:00Z", intradayBars, dailyBars: bars, currentRate: 144 })).toBe(151);
    expect(lookupFxRate({ dateOrTimestamp: "2025-01-02", intradayBars, dailyBars: bars, currentRate: 144 })).toBe(150);
  });

  it("smoothly tracks an intraday drop in USD/JPY without producing a terminal spike", async () => {
    const { convertAmount } = await import("../../components/dashboard/helpers");
    const stockBarsUsd = [
      { timestamp: "2025-01-06T14:00:00Z", price: "100" },
      { timestamp: "2025-01-06T14:30:00Z", price: "100" },
      { timestamp: "2025-01-06T15:00:00Z", price: "100" },
      { timestamp: "2025-01-06T15:30:00Z", price: "100" },
    ];

    const convertedPrices = stockBarsUsd.map((bar) => {
      const rate = historicalFxRateAtTimestamp(intradayBars, bars, bar.timestamp, 145);
      return Number(convertAmount(bar.price, "USD", "JPY", rate));
    });

    // Instead of flat 15200 with terminal jump, rates track: 15200 -> 15100 -> 14800 -> 14500
    expect(convertedPrices).toEqual([15200, 15100, 14800, 14500]);
  });
});

describe("currency exchange and convertAmount", () => {
  it("converts USD stock price to JPY accurately with given FX rate", () => {
    const converted = convertAmount("200.50", "USD", "JPY", 150);
    expect(converted).toBe("30075");
  });

  it("converts JPY stock price to USD accurately with given FX rate", () => {
    const converted = convertAmount("3000", "JPY", "USD", 150);
    expect(converted).toBe("20");
  });

  it("reports unavailable conversion when FX is missing or invalid", () => {
    const convertedNull = convertAmount("100", "USD", "JPY", null);
    expect(convertedNull).toBeNull();

    const convertedInvalid = convertAmount("100", "USD", "JPY", Number.NaN);
    expect(convertedInvalid).toBeNull();
  });

  it("normalizes case differences in currency codes", () => {
    const converted = convertAmount("100", "usd", "jpy", 155);
    expect(converted).toBe("15500");
  });

  it("strips commas and whitespace from input strings", () => {
    const converted = convertAmount(" 1,500.00 ", "USD", "JPY", 150);
    expect(converted).toBe("225000");
  });

  it("leaves values untouched when from and to currencies match or when target is NATIVE", () => {
    expect(convertAmount("1500", "USD", "USD", 150)).toBe("1500");
    expect(convertAmount("1500", "USD", "NATIVE", 150)).toBe("1500");
    expect(convertAmount("3000", "JPY", "JPY", 150)).toBe("3000");
  });

  it("validates USD/JPY exchange rate bounds", () => {
    expect(validUsdJpy(155.5)).toBe(true);
    expect(validUsdJpy(50)).toBe(true);
    expect(validUsdJpy(300)).toBe(true);
    expect(validUsdJpy(49.9)).toBe(false);
    expect(validUsdJpy(300.1)).toBe(false);
    expect(validUsdJpy(null)).toBe(false);
    expect(validUsdJpy(undefined)).toBe(false);
    expect(validUsdJpy(Number.NaN)).toBe(false);
  });
});

