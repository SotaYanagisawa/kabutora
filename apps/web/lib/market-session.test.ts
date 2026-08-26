import { describe, expect, it, vi } from "vitest";
import { japanMarketSession, portfolioMarketSessions, selectReliableMarketSessions, usMarketSession } from "./market-session";

describe("market session diagnostics", () => {
  it("distinguishes TSE, PTS daytime, and PTS nighttime sessions", () => {
    expect(japanMarketSession(new Date("2026-08-12T00:15:00Z")).session).toBe("regular");
    expect(japanMarketSession(new Date("2026-08-12T02:45:00Z")).session).toBe("pts_day");
    expect(japanMarketSession(new Date("2026-08-12T08:30:00Z")).session).toBe("pts_night");
  });

  it("explains Japanese holidays and weekends", () => {
    const holiday = japanMarketSession(new Date("2026-08-11T03:00:00Z"));
    expect(holiday).toMatchObject({ isOpen: false, label: "祝日休場", reason: "山の日", calendarSource: "official" });
    const weekend = japanMarketSession(new Date("2026-08-15T03:00:00Z"));
    expect(weekend).toMatchObject({ isOpen: false, label: "週末休場", reason: "土日" });
  });

  it("keeps a Friday PTS nighttime session open into Saturday morning", () => {
    expect(japanMarketSession(new Date("2026-08-14T20:00:00Z"))).toMatchObject({ isOpen: true, session: "pts_night" });
  });

  it("distinguishes US pre-market, regular, and after-hours", () => {
    expect(usMarketSession(new Date("2026-08-12T12:00:00Z")).session).toBe("pre_market");
    expect(usMarketSession(new Date("2026-08-12T18:00:00Z")).session).toBe("regular");
    expect(usMarketSession(new Date("2026-08-12T22:00:00Z")).session).toBe("after_hours");
  });

  it("handles the US daylight-saving boundaries without device timezone APIs", () => {
    expect(usMarketSession(new Date("2026-03-09T08:30:00Z"))).toMatchObject({ isOpen: true, session: "pre_market" });
    expect(usMarketSession(new Date("2026-11-02T09:30:00Z"))).toMatchObject({ isOpen: true, session: "pre_market" });
  });

  it("does not depend on Intl timezone data provided by the phone", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => { throw new Error("timezone data unavailable"); });
    try {
      expect(portfolioMarketSessions("ALL", new Date("2026-08-12T12:00:00Z"))).toEqual([
        expect.objectContaining({ market: "JP", session: "pts_night" }),
        expect.objectContaining({ market: "US", session: "pre_market" }),
      ]);
    } finally {
      formatter.mockRestore();
    }
  });

  it("explains US holidays and official early closes", () => {
    expect(usMarketSession(new Date("2026-12-25T17:00:00Z"))).toMatchObject({ isOpen: false, label: "祝日休場", reason: "クリスマス" });
    expect(usMarketSession(new Date("2026-11-27T19:00:00Z"))).toMatchObject({ isOpen: true, session: "after_hours" });
    expect(usMarketSession(new Date("2026-11-27T22:30:00Z"))).toMatchObject({ isOpen: false, label: "時間外終了" });
  });

  it("fails closed without crashing when a device cannot provide a valid clock", () => {
    expect(portfolioMarketSessions("ALL", new Date(Number.NaN))).toEqual([
      expect.objectContaining({ market: "JP", session: "unknown", label: "判定不能" }),
      expect.objectContaining({ market: "US", session: "unknown", label: "判定不能" }),
    ]);
  });

  it("uses a server-calculated session when a device evaluator fails", () => {
    const failed = portfolioMarketSessions("ALL", new Date(Number.NaN));
    const server = portfolioMarketSessions("ALL", new Date("2026-08-12T12:00:00Z"));
    expect(selectReliableMarketSessions("ALL", failed, server).map((status) => status.session)).toEqual(["pts_night", "pre_market"]);
    expect(selectReliableMarketSessions("US", failed, server)).toEqual([expect.objectContaining({ market: "US", session: "pre_market" })]);
  });
});
