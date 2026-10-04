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

  it("orders bars by date, then by locale-collated security ID, so cached checksums stay stable", () => {
    const ids = ["sec-b", "Sec-A", "sec-a", "sec-1300-xtks", "sec-us-x-xnas"];
    const bars = ids.flatMap((securityId) => ["2026-01-03", "2026-01-02"].map((date) => ({ securityId, date, close: "100", provider: "fixture" })));
    const { bars: sorted } = inspectMarketHistory([], bars, []);
    const collated = [...ids].sort((left, right) => left.localeCompare(right));

    expect(sorted.map((bar) => `${bar.date}|${bar.securityId}`)).toEqual(["2026-01-02", "2026-01-03"].flatMap((date) => collated.map((id) => `${date}|${id}`)));
  });

  it("rejects calendar dates that do not exist", () => {
    const result = inspectMarketHistory([], [
      { securityId: "sec-a", date: "2026-02-29", close: "100", provider: "fixture" },
      { securityId: "sec-a", date: "2024-02-29", close: "100", provider: "fixture" },
    ], []);

    expect(result.bars.map((bar) => bar.date)).toEqual(["2024-02-29"]);
    expect(result.quality.rejectedBars).toBe(1);
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

  it("detects and repairs an isolated sharp price dip by interpolation", () => {
    const bars = [
      { securityId: "sec-us-aapl", date: "2026-01-02", close: "250", adjustedClose: "250", provider: "network" },
      { securityId: "sec-us-aapl", date: "2026-01-05", close: "25", adjustedClose: "25", provider: "network" }, // 90% dip anomaly
      { securityId: "sec-us-aapl", date: "2026-01-06", close: "252", adjustedClose: "252", provider: "network" },
    ];
    const result = inspectMarketHistory([], bars, []);

    expect(result.quality.repairedBars).toBe(1);
    expect(result.quality.status).toBe("valid");
    expect(result.quality.suspectMoves).toBe(0);

    const repairedBar = result.bars.find((b) => b.date === "2026-01-05");
    expect(repairedBar).toBeDefined();
    // Linear interpolation between 2026-01-02 (250) and 2026-01-06 (252) for 2026-01-05 (3 days of 4) is 251.5
    expect(repairedBar!.close).toBe("251.5");
    expect(repairedBar!.adjustedClose).toBe("251.5");
  });

  it("detects and repairs an isolated adjustedClose glitch while close was fine", () => {
    const bars = [
      { securityId: "sec-us-msft", date: "2026-02-02", close: "400", adjustedClose: "400", provider: "network" },
      { securityId: "sec-us-msft", date: "2026-02-03", close: "402", adjustedClose: "4", provider: "network" }, // 99% adjustedClose glitch
      { securityId: "sec-us-msft", date: "2026-02-04", close: "404", adjustedClose: "404", provider: "network" },
    ];
    const result = inspectMarketHistory([], bars, []);

    expect(result.quality.repairedBars).toBe(1);
    expect(result.quality.status).toBe("valid");

    const repairedBar = result.bars.find((b) => b.date === "2026-02-03");
    expect(repairedBar).toBeDefined();
    expect(repairedBar!.close).toBe("402");
    expect(repairedBar!.adjustedClose).toBe("402");
  });

  it("guards against a sharp dip on the trailing edge bar", () => {
    const bars = [
      { securityId: "sec-7203", date: "2026-03-02", close: "3000", provider: "network" },
      { securityId: "sec-7203", date: "2026-03-03", close: "3010", provider: "network" },
      { securityId: "sec-7203", date: "2026-03-04", close: "300", provider: "network" }, // 90% plunge on final bar without split
    ];
    const result = inspectMarketHistory([], bars, []);

    expect(result.quality.repairedBars).toBe(1);
    expect(result.quality.status).toBe("valid");

    const finalBar = result.bars.at(-1);
    expect(finalBar?.date === "2026-03-04").toBe(true);
    expect(finalBar?.close).toBe("3010");
  });

  it("detects and repairs two consecutive anomalous bars", () => {
    const bars = [
      { securityId: "sec-7203", date: "2026-03-02", close: "3000", provider: "network" },
      { securityId: "sec-7203", date: "2026-03-03", close: "300", provider: "network" }, // glitch day 1
      { securityId: "sec-7203", date: "2026-03-04", close: "310", provider: "network" }, // glitch day 2
      { securityId: "sec-7203", date: "2026-03-05", close: "3030", provider: "network" },
    ];
    const result = inspectMarketHistory([], bars, []);

    expect(result.quality.repairedBars).toBe(2);
    expect(result.quality.status).toBe("valid");

    const bar1 = result.bars.find((b) => b.date === "2026-03-03");
    const bar2 = result.bars.find((b) => b.date === "2026-03-04");
    expect(Number(bar1?.close)).toBeGreaterThan(2900);
    expect(Number(bar2?.close)).toBeGreaterThan(2900);
  });
});
