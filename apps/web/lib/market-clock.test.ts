import { describe, expect, it } from "vitest";
import { resolveMarketClock, trustedMarketClockAnchor } from "./market-clock";

describe("market clock", () => {
  it("uses server epoch plus monotonic elapsed time even when the device clock is invalid", () => {
    const anchor = trustedMarketClockAnchor(Date.UTC(2026, 7, 12, 12), 1_000);
    expect(resolveMarketClock(anchor, 31_000, Number.NaN)).toBe(Date.UTC(2026, 7, 12, 12, 0, 30));
  });

  it("uses a valid device clock only until a trusted server timestamp is available", () => {
    expect(resolveMarketClock(null, 500, 1_786_536_000_000)).toBe(1_786_536_000_000);
    expect(resolveMarketClock(null, 500, Number.NaN)).toBeNull();
  });

  it("never moves backward when a monotonic reading resets", () => {
    const anchor = trustedMarketClockAnchor(1_786_536_000_000, 5_000);
    expect(resolveMarketClock(anchor, 1_000, Number.NaN)).toBe(1_786_536_000_000);
  });
});
