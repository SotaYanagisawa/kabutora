import { describe, expect, it } from "vitest";
import { mergeIntradayBars } from "./intraday-cache";

describe("intraday cache compaction", () => {
  it("merges incremental bars, replaces duplicates, and removes expired rows", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    const merged = mergeIntradayBars(
      [
        { securityId: "sec-a", timestamp: "2026-08-01T12:00:00Z", price: "90", provider: "old" },
        { securityId: "sec-a", timestamp: "2026-08-12T11:45:00Z", price: "100", provider: "cache" },
      ],
      [
        { securityId: "sec-a", timestamp: "2026-08-12T11:45:00Z", price: "101", provider: "network" },
        { securityId: "sec-b", timestamp: "2026-08-12T11:45:00Z", price: "200", provider: "network" },
      ],
      now,
    );

    expect(merged).toEqual([
      { securityId: "sec-a", timestamp: "2026-08-12T11:45:00Z", price: "101", provider: "network" },
      { securityId: "sec-b", timestamp: "2026-08-12T11:45:00Z", price: "200", provider: "network" },
    ]);
  });

  it("detects and repairs isolated knife drop in intraday series", () => {
    const bars = [
      { securityId: "sec-a", timestamp: "2026-08-12T10:00:00Z", price: "100", provider: "test" },
      { securityId: "sec-a", timestamp: "2026-08-12T10:05:00Z", price: "10", provider: "test" }, // 90% plunge glitch
      { securityId: "sec-a", timestamp: "2026-08-12T10:10:00Z", price: "102", provider: "test" },
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-08-12T11:00:00Z").getTime());
    expect(merged).toHaveLength(3);
    expect(merged[1].price).toBe("101");
  });

  it("detects and repairs consecutive two-bar dip in intraday series", () => {
    const bars = [
      { securityId: "sec-a", timestamp: "2026-08-12T10:00:00Z", price: "100", provider: "test" },
      { securityId: "sec-a", timestamp: "2026-08-12T10:05:00Z", price: "50", provider: "test" }, // bad window
      { securityId: "sec-a", timestamp: "2026-08-12T10:10:00Z", price: "52", provider: "test" }, // bad window
      { securityId: "sec-a", timestamp: "2026-08-12T10:15:00Z", price: "103", provider: "test" },
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-08-12T11:00:00Z").getTime());
    expect(merged).toHaveLength(4);
    expect(merged[1].price).toBe("101");
    expect(merged[2].price).toBe("102");
  });

  it("guards against sharp drop on trailing intraday edge bar", () => {
    const bars = [
      { securityId: "sec-a", timestamp: "2026-08-12T10:00:00Z", price: "3000", provider: "test" },
      { securityId: "sec-a", timestamp: "2026-08-12T10:05:00Z", price: "3010", provider: "test" },
      { securityId: "sec-a", timestamp: "2026-08-12T10:10:00Z", price: "300", provider: "test" }, // 90% plunge at tail
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-08-12T11:00:00Z").getTime());
    expect(merged).toHaveLength(3);
    expect(merged[2].price).toBe("3010");
  });

  it("detects and repairs after-hours aberrant bad tick (e.g. GOOGL 5.4% drop)", () => {
    const bars = [
      { securityId: "sec-googl", timestamp: "2026-09-16T20:55:00Z", price: "343.15", provider: "yahoo" },
      { securityId: "sec-googl", timestamp: "2026-09-16T21:00:00Z", price: "324.65", provider: "yahoo" }, // 5.39% off-market drop
      { securityId: "sec-googl", timestamp: "2026-09-16T21:05:00Z", price: "343.33", provider: "yahoo" },
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-09-16T22:00:00Z").getTime());
    expect(merged).toHaveLength(3);
    expect(merged[1].price).toBe("343.24");
  });

  it("detects and repairs after-hours aberrant spike (e.g. AMZN 4.9% spike)", () => {
    const bars = [
      { securityId: "sec-amzn", timestamp: "2026-09-10T20:45:00Z", price: "252.00", provider: "yahoo" },
      { securityId: "sec-amzn", timestamp: "2026-09-10T20:50:00Z", price: "264.35", provider: "yahoo" }, // 4.9% spike
      { securityId: "sec-amzn", timestamp: "2026-09-10T20:55:00Z", price: "251.84", provider: "yahoo" },
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-09-10T22:00:00Z").getTime());
    expect(merged).toHaveLength(3);
    expect(merged[1].price).toBe("251.92");
  });

  it("preserves legitimate market moves", () => {
    const bars = [
      { securityId: "sec-a", timestamp: "2026-08-12T10:00:00Z", price: "100.00", provider: "test" },
      { securityId: "sec-a", timestamp: "2026-08-12T10:05:00Z", price: "98.50", provider: "test" }, // 1.5% normal dip
      { securityId: "sec-a", timestamp: "2026-08-12T10:10:00Z", price: "99.00", provider: "test" },
    ];
    const merged = mergeIntradayBars([], bars, new Date("2026-08-12T11:00:00Z").getTime());
    expect(merged).toHaveLength(3);
    expect(merged[1].price).toBe("98.50");
  });
});
