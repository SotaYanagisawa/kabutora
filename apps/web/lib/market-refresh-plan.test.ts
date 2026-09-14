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

  it("refreshes active quotes after ten minutes and closed quotes after six hours", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    expect(quoteRefreshTargets(["active", "closed"], {
      active: { session: "after_hours", fetchedAt: "2026-08-12T11:50:00Z" },
      closed: { session: "closed", fetchedAt: "2026-08-12T06:00:00Z" },
    }, { now })).toEqual(["active", "closed"]);
  });

  it("allows an explicit full or forced refresh for every tracked ticker", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `sec-${index}`);
    expect(quoteRefreshTargets(ids, {}, { full: true })).toHaveLength(200);
    expect(quoteRefreshTargets(ids, {}, { force: true })).toHaveLength(200);
  });

  it("invalidates a Japanese close as soon as the night PTS session opens for both -xtks and base ID", () => {
    const now = new Date("2026-08-12T09:00:00Z").getTime();
    const idWithMic = "sec-7203-xtks";
    const idBase = "sec-7203";
    expect(quoteRefreshTargets([idWithMic], {
      [idWithMic]: { session: "closed", fetchedAt: "2026-08-12T08:59:30Z" },
    }, { now })).toEqual([idWithMic]);
    expect(quoteRefreshTargets([idBase], {
      [idBase]: { session: "closed", fetchedAt: "2026-08-12T08:59:30Z" },
    }, { now })).toEqual([idBase]);
  });

  it("finds cached quotes across security ID variants", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    // Cache has sec-7203-xtks, query asks for sec-7203 (market is pts_night at 21:00 JST)
    expect(quoteRefreshTargets(["sec-7203"], {
      "sec-7203-xtks": { session: "pts_night", fetchedAt: "2026-08-12T11:55:00Z" },
    }, { now })).toEqual([]);
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

  it("enforces minimum throttle so quotes fetched in the last 15 seconds are never refetched immediately", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    const id = "sec-7203-xtks";
    // Even with a session mismatch and no intraday data, quote fetched 5s ago must not be refetched
    expect(quoteRefreshTargets([id], {
      [id]: { session: "closed", fetchedAt: new Date(now - 5_000).toISOString() },
    }, { now, hasIntraday: () => false })).toEqual([]);
  });

  it("does not flag mutual funds or FX as needing intraday refresh when their quotes are fresh", () => {
    const now = new Date("2026-08-12T12:00:00Z").getTime();
    const ids = ["sec-jp-fund-0331418a", "sec-foreign-fund-21070062", "sec-fx-usdjpy"];
    const quotes = {
      "sec-jp-fund-0331418a": { session: "closed" as const, venueCode: "FUND", fetchedAt: new Date(now - 60_000).toISOString() },
      "sec-foreign-fund-21070062": { session: "closed" as const, venueCode: "FUND", fetchedAt: new Date(now - 60_000).toISOString() },
      "sec-fx-usdjpy": { session: "regular" as const, venueCode: "FX", fetchedAt: new Date(now - 60_000).toISOString() },
    };
    // No intraday data available for any of these
    expect(quoteRefreshTargets(ids, quotes, { now, hasIntraday: () => false })).toEqual([]);
  });
});
