import { describe, expect, it } from "vitest";
import { buildHistoryFetchPlan, firstInternalHistoryGap, historyRequirementSatisfied, missingHistoryRequirements, splitSecurityIds } from "./market-fetch-plan";

describe("market fetch planning", () => {
  it("never silently drops securities beyond the provider request limit", () => {
    const ids = Array.from({ length: 53 }, (_, index) => `sec-${index}`).join(",");
    const batches = splitSecurityIds(ids);
    expect(batches.map((batch) => batch.length)).toEqual([8, 8, 8, 8, 8, 8, 5]);
    expect(batches.flat()).toHaveLength(53);
    expect(splitSecurityIds(Array.from({ length: 200 }, (_, index) => `sec-scale-${index}`).join(","))).toHaveLength(25);
  });

  it("deep-backfills only when required and otherwise overlaps the recent tail", () => {
    const requirements = new Map([["sec-a", "2026-08-01"], ["sec-b", "2025-01-01"]]);
    const plan = buildHistoryFetchPlan("sec-a,sec-b", requirements, [
      { securityId: "sec-a", date: "2026-08-01", close: "100", provider: "cache" },
      { securityId: "sec-a", date: "2026-08-10", close: "120", provider: "cache" },
    ]);
    expect(plan).toEqual([{ securityIds: ["sec-b", "sec-a"], from: "2025-01-01" }]);
    expect(missingHistoryRequirements([], requirements)).toEqual(["sec-a", "sec-b"]);
  });

  it("groups securities with similar start dates to limit deep-backfill overfetch", () => {
    const requirements = new Map(Array.from({ length: 6 }, (_, index) => [
      `sec-${index}`,
      index < 3 ? `2020-01-0${index + 1}` : `2026-01-0${index + 1}`,
    ]));
    const plan = buildHistoryFetchPlan([...requirements.keys()].reverse().join(","), requirements, [], 3);

    expect(plan).toEqual([
      { securityIds: ["sec-0", "sec-1", "sec-2"], from: "2020-01-01" },
      { securityIds: ["sec-3", "sec-4", "sec-5"], from: "2026-01-04" },
    ]);
  });

  it("accepts the first trading bar after a weekend or holiday transaction date", () => {
    const requirements = new Map([["sec-weekend", "2026-08-08"]]);
    const bars = [{ securityId: "sec-weekend", date: "2026-08-10", close: "100", provider: "fixture" }];
    expect(historyRequirementSatisfied("2026-08-10", "2026-08-08")).toBe(true);
    expect(missingHistoryRequirements(bars, requirements)).toEqual([]);
    expect(buildHistoryFetchPlan("sec-weekend", requirements, bars)).toEqual([{ securityIds: ["sec-weekend"], from: "2026-08-03" }]);
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
    expect(buildHistoryFetchPlan("sec-ipo", requirements, bars, 16, inceptionDates)).toEqual([
      { securityIds: ["sec-ipo"], from: "2026-06-05" },
    ]);
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
    expect(buildHistoryFetchPlan("sec-us", requirements, bars)).toEqual([{ securityIds: ["sec-us"], from: "2024-01-04", forceRefresh: true }]);
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
    expect(buildHistoryFetchPlan("sec-stale", requirements, bars, 8, {}, "2026-05-15")).toEqual([
      { securityIds: ["sec-stale"], from: "2026-03-16", forceRefresh: true },
    ]);
  });

  it("triggers forceRefresh when the series tail is older than 4 days from throughDate", () => {
    const requirements = new Map([["sec-recent", "2026-09-01"]]);
    const bars = [
      { securityId: "sec-recent", date: "2026-09-01", close: "100", provider: "cache" },
      { securityId: "sec-recent", date: "2026-09-08", close: "105", provider: "cache" },
    ];
    // Through date is 2026-09-16 (8 days later, <= 14 days so not a full gap, but tail is stale > 4 days)
    const plan = buildHistoryFetchPlan("sec-recent", requirements, bars, 8, {}, "2026-09-16");
    expect(plan).toEqual([
      { securityIds: ["sec-recent"], from: "2026-09-01", forceRefresh: true },
    ]);
  });
});
