import { describe, expect, it } from "vitest";
import { japannextPtsWindowAt, normalizeJapanesePtsSymbol, parseJapannextPtsSource } from "./japannext-pts";

describe("Japannext PTS public feed", () => {
  it("parses assignment rows as inert data and keeps only requested symbols", () => {
    const source = [
      'mdata[ 1 ] = [ "7203", "", "", "", "2972.0", "3017.2", "2950.0", "3009.1", "278800.0" ];',
      'globalThis.compromised = true;',
      'mdata[ 2 ] = [ "9984", "", "", "", "100", "101", "99", "100.5", "1200" ];',
      'mdata[ 3 ] = [ "BAD", "", "", "", "100", "101", "99", "100.5", "1200" ];',
    ].join("\n");
    expect(parseJapannextPtsSource(source, new Set(["7203"]))).toEqual([{
      symbol: "7203",
      open: "2972.0",
      high: "3017.2",
      low: "2950.0",
      last: "3009.1",
      volume: "278800.0",
    }]);
    expect((globalThis as typeof globalThis & { compromised?: boolean }).compromised).toBeUndefined();
  });

  it("maps the day and cross-midnight night sessions to one Tokyo trading date", () => {
    expect(japannextPtsWindowAt(new Date("2026-09-10T23:20:00.000Z"))).toMatchObject({ venue: "day", sessionKey: "2026-09-11" });
    expect(japannextPtsWindowAt(new Date("2026-09-11T08:00:00.000Z"))).toMatchObject({ venue: "night", sessionKey: "2026-09-11" });
    expect(japannextPtsWindowAt(new Date("2026-09-11T16:00:00.000Z"))).toMatchObject({ venue: "night", sessionKey: "2026-09-11" });
    expect(japannextPtsWindowAt(new Date("2026-09-11T21:00:00.000Z"))).toBeNull();
  });

  it("normalizes listed Japanese provider symbols", () => {
    expect(normalizeJapanesePtsSymbol("7203.T")).toBe("7203");
    expect(normalizeJapanesePtsSymbol("285A.T")).toBe("285A");
    expect(normalizeJapanesePtsSymbol("AAPL")).toBeNull();
  });
});
