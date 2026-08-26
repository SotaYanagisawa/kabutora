import { describe, expect, it } from "vitest";
import { inspectMarketHistory, packHistoryBars, unpackHistoryBars } from "./market-history";

describe("market history integrity", () => {
  it("rejects malformed bars, replaces overlaps, and creates a stable checksum", () => {
    const existing = [
      { securityId: "sec-a", date: "2026-01-02", close: "100", provider: "cache" },
      { securityId: "sec-a", date: "2026-01-03", close: "110", provider: "cache" },
    ];
    const incoming = [
      { securityId: "sec-a", date: "2026-01-03", close: "111", provider: "network" },
      { securityId: "sec-a", date: "bad-date", close: "120", provider: "network" },
      { securityId: "sec-a", date: "2026-01-04", close: "NaN", provider: "network" },
    ];
    const first = inspectMarketHistory(existing, incoming, []);
    const second = inspectMarketHistory([], first.bars, first.actions);

    expect(first.bars.map((bar) => [bar.date, bar.close, bar.provider])).toEqual([
      ["2026-01-02", "100", "cache"],
      ["2026-01-03", "111", "network"],
    ]);
    expect(first.quality.rejectedBars).toBe(2);
    expect(first.quality.duplicateBars).toBe(1);
    expect(second.quality.checksum).toBe(first.quality.checksum);
  });

  it("accepts a large price move when a verified split explains it", () => {
    const result = inspectMarketHistory([], [
      { securityId: "sec-a", date: "2026-06-26", close: "10000", provider: "network" },
      { securityId: "sec-a", date: "2026-06-29", close: "2000", provider: "network" },
    ], [{
      id: "split-a", securityId: "sec-a", type: "SPLIT", effectiveDate: "2026-06-29",
      numerator: "5", denominator: "1", sourceProvider: "network",
    }]);

    expect(result.quality.status).toBe("valid");
    expect(result.quality.suspectMoves).toBe(0);
  });

  it("stores history as normalized per-security series without repeating identifiers", () => {
    const bars = [
      { securityId: "sec-a", date: "2026-01-02", close: "100", provider: "fixture" },
      { securityId: "sec-a", date: "2026-01-03", close: "101", provider: "fixture" },
      { securityId: "sec-b", date: "2026-01-02", close: "200", provider: "fixture" },
    ];
    const packed = packHistoryBars(bars);

    expect(packed["sec-a"].rows).toEqual([["2026-01-02", "100"], ["2026-01-03", "101"]]);
    expect(unpackHistoryBars(packed)).toEqual(bars);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(bars).length);
  });

  it("retains adjusted closes for split-corrected price charts", () => {
    const bars = [{ securityId: "sec-us-aapl-xnas", date: "2026-01-02", close: "250", adjustedClose: "249.5", provider: "fixture" }];
    const packed = packHistoryBars(bars);

    expect(packed["sec-us-aapl-xnas"].rows).toEqual([["2026-01-02", "250", "249.5"]]);
    expect(unpackHistoryBars(packed)).toEqual(bars);
    expect(inspectMarketHistory([], bars, []).quality.status).toBe("valid");
  });
});
