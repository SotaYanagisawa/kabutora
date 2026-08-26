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
});
