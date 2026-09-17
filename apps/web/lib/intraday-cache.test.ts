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
});
