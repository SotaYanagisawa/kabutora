import { describe, expect, it } from "vitest";
import { MARKET_WIRE_VERSION, packHistory, packSeries, parseHistoryPayload, parseSnapshotPayload, unpackHistory, unpackSeries } from "./market-wire";

describe("market wire format", () => {
  it("round-trips daily history records and slices from a year start", () => {
    const record = {
      key: "sec-8316", currency: "JPY", dates: ["2024-12-30", "2025-01-06", "2025-01-07"], closes: [3_000.000000001, 3_100, 3_120],
      splits: [{ date: "2024-09-27", ratio: 3 }, { date: "2026-09-29", ratio: 2 }], dividends: [{ date: "2025-03-28", amount: 31, payDate: "2025-06-20" }], fetchedAt: 5,
    };
    expect(unpackHistory("sec-8316", packHistory(record))).toEqual({ ...record, closes: [3_000, 3_100, 3_120] });
    expect(unpackHistory("sec-8316", packHistory(record, "2025-01-01"))).toMatchObject({ dates: ["2025-01-06", "2025-01-07"], splits: [{ date: "2026-09-29", ratio: 2 }] });
  });

  it("round-trips intraday series", () => {
    const series = { times: [1_000, 1_900, 2_800], prices: [1, 2.5, 3] };
    expect(packSeries(series).t).toEqual([1_000, 900, 900]);
    expect(unpackSeries(packSeries(series))).toEqual(series);
  });

  it("drops invalid quotes and series and rejects malformed envelopes", () => {
    const good = { key: "sec-1", price: 1, previousClose: null, time: 1, session: "closed", venue: "TSE", currency: "JPY", fetchedAt: 1 };
    const parsed = parseSnapshotPayload({
      version: MARKET_WIRE_VERSION, generatedAt: 1, revision: "r", catalog: ["sec-1"], benchmarks: [], historyRevision: "h", intradayRevision: "i",
      quotes: [good, { ...good, price: -1 }, { ...good, session: "lunch" }],
      intraday: { "sec-1": { t: [1], p: [1] }, "sec-2": { t: [1, 2], p: [1] } },
    });
    expect(parsed?.quotes).toEqual([good]);
    expect(Object.keys(parsed?.intraday ?? {})).toEqual(["sec-1"]);
    expect(parseSnapshotPayload({ version: 3 })).toBeNull();
    expect(parseHistoryPayload({ version: MARKET_WIRE_VERSION, revision: "r", records: { a: { c: "JPY", d: "2026-01-01", g: [0], p: [0], s: [], v: [], f: 1 } } })?.records).toEqual({});
  });
});
