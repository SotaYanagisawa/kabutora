import { describe, expect, it } from "vitest";
import { historicalFxRateAtDate } from "./historical-fx";

const bars = [
  { securityId: "sec-fx-usdjpy", date: "2025-01-02", close: "150", provider: "fixture" },
  { securityId: "sec-fx-usdjpy", date: "2025-01-06", close: "152", provider: "fixture" },
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
});

