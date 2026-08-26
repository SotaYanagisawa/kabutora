import { describe, expect, it } from "vitest";
import { quoteRefreshTargets } from "./market-refresh-plan";

describe("quote refresh planning", () => {
  it("does not refetch fresh cached quotes when a device reopens", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    expect(quoteRefreshTargets(["active", "closed", "missing"], {
      active: { session: "regular", fetchedAt: "2026-08-12T11:55:00Z" },
      closed: { session: "closed", fetchedAt: "2026-08-12T08:00:00Z" },
    }, { now })).toEqual(["missing"]);
  });

  it("refreshes active quotes after nine minutes and closed quotes after six hours", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    expect(quoteRefreshTargets(["active", "closed"], {
      active: { session: "after_hours", fetchedAt: "2026-08-12T11:51:00Z" },
      closed: { session: "closed", fetchedAt: "2026-08-12T06:00:00Z" },
    }, { now })).toEqual(["active", "closed"]);
  });

  it("allows an explicit full or forced refresh for every tracked ticker", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `sec-${index}`);
    expect(quoteRefreshTargets(ids, {}, { full: true })).toHaveLength(200);
    expect(quoteRefreshTargets(ids, {}, { force: true })).toHaveLength(200);
  });

  it("invalidates a Japanese close as soon as the night PTS session opens", () => {
    const now = new Date("2026-08-12T09:00:00Z").getTime();
    const id = "sec-7203-xtks";
    expect(quoteRefreshTargets([id], {
      [id]: { session: "closed", fetchedAt: "2026-08-12T08:59:30Z" },
    }, { now })).toEqual([id]);
  });

  it("invalidates a closed US quote when pre-market opens and a regular quote when after-hours opens", () => {
    const id = "sec-us-aapl-xnas";
    expect(quoteRefreshTargets([id], {
      [id]: { session: "closed", fetchedAt: "2026-08-12T11:59:30Z" },
    }, { now: new Date("2026-08-12T12:00:00Z").getTime() })).toEqual([id]);
    expect(quoteRefreshTargets([id], {
      [id]: { session: "regular", fetchedAt: "2026-08-12T20:00:30Z" },
    }, { now: new Date("2026-08-12T20:01:00Z").getTime() })).toEqual([id]);
  });
});
