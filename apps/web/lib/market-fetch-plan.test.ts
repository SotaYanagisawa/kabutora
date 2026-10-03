import { describe, expect, it } from "vitest";
import { firstInternalHistoryGap, historyRequirementSatisfied, missingHistoryRequirements, splitSecurityIds } from "./market-fetch-plan";

describe("market fetch planning", () => {
  it("splits id lists without dropping any security", () => {
    const ids = Array.from({ length: 53 }, (_, index) => `sec-${index}`).join(",");
    expect(splitSecurityIds(ids, 8).map((batch) => batch.length)).toEqual([8, 8, 8, 8, 8, 8, 5]);
    expect(splitSecurityIds(ids).flat()).toHaveLength(53);
  });

  it("accepts the first trading bar after a weekend or holiday transaction date", () => {
    const requirements = new Map([["sec-weekend", "2026-08-08"]]);
    const bars = [{ securityId: "sec-weekend", date: "2026-08-10", close: "100", provider: "fixture" }];
    expect(historyRequirementSatisfied("2026-08-10", "2026-08-08")).toBe(true);
    expect(missingHistoryRequirements(bars, requirements)).toEqual([]);
  });

  it("still reports a genuine history gap beyond seven calendar days", () => {
    const requirements = new Map([["sec-gap", "2026-08-01"]]);
    const bars = [{ securityId: "sec-gap", date: "2026-08-10", close: "100", provider: "fixture" }];
    expect(historyRequirementSatisfied("2026-08-10", "2026-08-01")).toBe(false);
    expect(missingHistoryRequirements(bars, requirements)).toEqual(["sec-gap"]);
  });

  it("accepts a post-transaction first bar when provider metadata proves a recent IPO", () => {
    const requirements = new Map([["sec-ipo", "2026-05-20"]]);
    const bars = [{ securityId: "sec-ipo", date: "2026-06-12", close: "42", provider: "fixture" }];
    const inceptionDates = { "sec-ipo": "2026-06-12" };
    expect(historyRequirementSatisfied("2026-06-12", "2026-05-20", 7, inceptionDates["sec-ipo"])).toBe(true);
    expect(missingHistoryRequirements(bars, requirements, inceptionDates)).toEqual([]);
  });

  it("detects and force-refetches a large gap inside an otherwise covered US series", () => {
    const requirements = new Map([["sec-us", "2024-01-02"]]);
    const bars = [
      { securityId: "sec-us", date: "2024-01-02", close: "100", provider: "cache" },
      { securityId: "sec-us", date: "2024-01-03", close: "101", provider: "cache" },
      { securityId: "sec-us", date: "2025-01-06", close: "150", provider: "cache" },
    ];
    expect(firstInternalHistoryGap(bars, "sec-us", "2024-01-02")).toBe("2024-01-04");
    expect(missingHistoryRequirements(bars, requirements)).toEqual(["sec-us"]);
  });

  it("detects a tail gap between the last available bar and throughDate", () => {
    const requirements = new Map([["sec-stale", "2026-03-01"]]);
    const bars = [
      { securityId: "sec-stale", date: "2026-03-01", close: "100", provider: "cache" },
      { securityId: "sec-stale", date: "2026-03-15", close: "105", provider: "cache" },
    ];
    // With throughDate 2 months later (2026-05-15)
    expect(firstInternalHistoryGap(bars, "sec-stale", "2026-03-01", 14, "2026-05-15")).toBe("2026-03-16");
    expect(missingHistoryRequirements(bars, requirements, {}, "2026-05-15")).toEqual(["sec-stale"]);
  });
});
