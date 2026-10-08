import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeUpstream, weekdays, type FakeSecurity } from "../../runtime-tests/fake-upstream";
import { unpackHistory, unpackSeries } from "../market/market-wire";
import { Budget } from "./market-upstream";
import { MarketService, MemoryMarketStore, serveMarket } from "./market-service";

/** Monday 2026-10-05 21:00 UTC: Tokyo is closed (06:00 JST Tue) and New York has closed too. */
const START = Date.parse("2026-10-05T21:00:00Z");

const kioxiaDates = weekdays("2026-09-01", "2026-10-05");
const kioxia = (splitApplied: boolean): FakeSecurity => ({
  currency: "JPY",
  zone: "Asia/Tokyo",
  // Before 09-29 Yahoo shows closes divided by 3 once the split is known; before that, raw prices.
  closes: kioxiaDates.map((date, index) => [date, date < "2026-09-29" && !splitApplied ? 54_000 + index * 10 : 18_000 + index * 3]),
  splits: splitApplied ? [["2026-09-29", 3, 1]] : [],
  dividends: [["2026-09-29", 30]],
  price: 18_735,
  previousClose: 19_120,
  name: "KIOXIA HOLDINGS CORP",
});

function setup(options: { splitApplied?: boolean; pts?: Record<string, number | { last: number; volume: number }>; ptsModifiedAt?: () => number } = {}) {
  let now = START;
  const securities: Record<string, FakeSecurity> = {
    "285A.T": kioxia(options.splitApplied ?? true),
    "AAPL": { currency: "USD", zone: "America/New_York", closes: weekdays("2026-09-01", "2026-10-05").map((date) => [date, 250]), price: 255, previousClose: 250, name: "Apple Inc." },
    "JPY=X": { currency: "JPY", zone: "Asia/Tokyo", closes: weekdays("2026-09-01", "2026-10-05").map((date) => [date, 150]), price: 151, previousClose: 150 },
    "^GSPC": { currency: "USD", zone: "America/New_York", closes: [], price: 7_000, previousClose: 6_950 },
  };
  const upstream = createFakeUpstream({
    now: () => now,
    securities,
    funds: { "02311886": { name: "インデックスファンド225", closes: weekdays("2026-09-01", "2026-10-05").map((date, index) => [date, 20_000 + index]), distributions: [["2026-06-16", 0], ["2025-06-16", 130]] } },
    pts: options.pts,
    ptsModifiedAt: options.ptsModifiedAt,
  });
  vi.stubGlobal("fetch", upstream.fetch);
  const continuation = vi.fn();
  const store = new MemoryMarketStore();
  const service = new MarketService(store, { now: () => now, scheduleContinuation: continuation });
  return { service, store, upstream, securities, continuation, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("MarketService catalog", () => {
  it("normalizes registrations to one key per security and rejects unknown ids", async () => {
    const { service } = setup();
    expect(await service.register(["sec-285a-xtks", "sec-285A", "285A.T", "nonsense"])).toEqual({ added: ["sec-285a"], rejected: ["nonsense"], size: 1 });
    expect(await service.register(["sec-us-aapl-xnas"])).toEqual({ added: ["sec-us-aapl"], rejected: [], size: 2 });
  });
});

describe("MarketService snapshot", () => {
  it("serves catalog-wide quotes, benchmarks and intraday series, sharing one refresh between readers", async () => {
    const { service, upstream } = setup();
    await service.register(["sec-285a-xtks", "sec-us-aapl-xnas"]);
    const [first, second] = await Promise.all([service.snapshot(), service.snapshot()]);
    expect(first.quotes.map((quote) => [quote.key, quote.price])).toEqual([["sec-fx-usdjpy", 151], ["sec-285a", 18_735], ["sec-us-aapl", 255]]);
    expect(first.quotes.find((quote) => quote.key === "sec-us-aapl")).toMatchObject({ venue: "US", currency: "USD", previousClose: 250 });
    expect(first.benchmarks.find((item) => item.id === "sp500")?.value).toBe(7_000);
    expect(unpackSeries(first.intraday!["sec-285a"]).times.length).toBe(40);
    expect(second.revision).toBe(first.revision);
    expect(upstream.state.byPath.get("spark:1d")).toBe(1);

    const warm = await service.snapshot({ intradayRevision: first.intradayRevision });
    expect(warm.intraday).toBeUndefined();
    expect(upstream.state.byPath.get("spark:1d")).toBe(1);
  });

  it("answers 304 for an unchanged snapshot and keeps the last quotes during an outage", async () => {
    const { service, upstream, advance } = setup();
    await service.register(["sec-285a"]);
    const first = await serveMarket(new Request("https://k/api/market/snapshot"), service, { maxRegister: 1 });
    const etag = first.headers.get("ETag")!;
    const again = await serveMarket(new Request("https://k/api/market/snapshot", { headers: { "If-None-Match": etag } }), service, { maxRegister: 1 });
    expect(again.status).toBe(304);
    upstream.state.fail = true;
    advance(60_000);
    const stale = await service.snapshot();
    expect(stale.quotes.find((quote) => quote.key === "sec-285a")?.price).toBe(18_735);
  });

  it("uses a newer Japannext trade after the TSE close", async () => {
    const { service, setNow } = setup({ pts: { "285A": 18_900 } });
    setNow(Date.parse("2026-10-05T13:00:00Z")); // 22:00 JST: PTS night session
    await service.register(["sec-285a"]);
    await service.snapshot();
    await service.tick(new Budget(45));
    const snapshot = await service.snapshot();
    const quote = snapshot.quotes.find((item) => item.key === "sec-285a")!;
    expect(quote).toMatchObject({ price: 18_900, venue: "JNX", session: "pts_night", previousClose: 19_120, regularPrice: 18_735 });
    expect(quote.regularTime).toBeLessThan(quote.time);
  });

  it("keeps a night PTS trade into the morning and ignores a day-session trade until it trades again", async () => {
    const pts: Record<string, { last: number; volume: number }> = { "285A": { last: 18_900, volume: 100 } };
    const { service, setNow, advance, securities } = setup({ pts });
    securities["285A.T"].time = Date.parse("2026-10-05T06:30:00Z") / 1000; // TSE close 15:30 JST
    setNow(Date.parse("2026-10-05T13:00:00Z")); // 22:00 JST: night session
    await service.register(["sec-285a"]);
    await service.snapshot();
    await service.tick(new Budget(45));
    // 08:30 JST: the day session has opened, but this symbol has not traded in it yet.
    pts["285A"] = { last: 18_850, volume: 0 };
    setNow(Date.parse("2026-10-05T23:30:00Z"));
    await service.tick(new Budget(45));
    expect((await service.snapshot()).quotes.find((item) => item.key === "sec-285a")).toMatchObject({ price: 18_900, session: "pts_night" });

    // A day-session file first seen after the TSE close may hold trades from before it.
    pts["285A"] = { last: 18_700, volume: 500 };
    securities["285A.T"].time = Date.parse("2026-10-06T06:30:00Z") / 1000;
    setNow(Date.parse("2026-10-06T06:40:00Z")); // 15:40 JST
    await service.tick(new Budget(45));
    const unchanged = (await service.snapshot()).quotes.find((item) => item.key === "sec-285a")!;
    expect(unchanged.venue).toBe("TSE");
    // It trades again after the close: now it is the quote.
    pts["285A"] = { last: 18_780, volume: 600 };
    advance(60_000);
    await service.tick(new Budget(45));
    expect((await service.snapshot()).quotes.find((item) => item.key === "sec-285a")).toMatchObject({ price: 18_780, venue: "JNX", session: "pts_day" });
  });

  it("ignores a Japannext file left over from the previous session", async () => {
    let modified = Date.parse("2026-10-05T07:00:00Z"); // 16:00 JST, day session
    const { service, setNow } = setup({ pts: { "285A": 18_900 }, ptsModifiedAt: () => modified });
    setNow(Date.parse("2026-10-05T08:05:00Z")); // 17:05 JST: night session, file not rewritten yet
    await service.register(["sec-285a"]);
    await service.snapshot();
    await service.tick(new Budget(45));
    expect((await service.snapshot()).quotes.find((item) => item.key === "sec-285a")?.venue).toBe("TSE");
    modified = Date.parse("2026-10-05T08:06:00Z");
    setNow(Date.parse("2026-10-05T08:07:00Z"));
    await service.tick(new Budget(45));
    expect((await service.snapshot()).quotes.find((item) => item.key === "sec-285a")).toMatchObject({ price: 18_900, venue: "JNX" });
  });

  it("answers from memory while a background refresh runs, and waits only for old quotes", async () => {
    const { service, upstream, advance } = setup();
    await service.register(["sec-285a"]);
    await service.snapshot();
    expect(upstream.state.byPath.get("spark:1d")).toBe(1);
    upstream.state.latencyMs = 1_500;
    advance(10_000);
    const started = performance.now();
    await service.snapshot();
    expect(performance.now() - started).toBeLessThan(500);
    
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(upstream.state.byPath.get("spark:1d")).toBe(2);
  });

  it("keeps quotes warm from the cron only while someone reads", async () => {
    const { service, upstream, advance } = setup();
    await service.register(["sec-285a"]);
    await service.snapshot();
    advance(60_000);
    await service.tick(new Budget(45));
    expect(upstream.state.byPath.get("spark:1d")).toBe(2);
    advance(20 * 60_000);
    await service.tick(new Budget(45));
    expect(upstream.state.byPath.get("spark:1d")).toBe(2);
  });
});

describe("MarketService history", () => {
  it("returns split-adjusted closes, the split and same-day dividends in one record", async () => {
    const { service } = setup();
    await service.register(["sec-285a"]);
    const payload = await service.history("2026-01-01");
    const record = unpackHistory("sec-285a", payload.records["sec-285a"]);
    expect(record.splits).toEqual([{ date: "2026-09-29", ratio: 3 }]);
    expect(record.dividends).toEqual([{ date: "2026-09-29", amount: 10 }]);
    expect(record.dates[0]).toBe("2026-09-01");
    expect(record.closes.every((close) => close < 20_000)).toBe(true);
    expect(payload.pending).toEqual([]);
  });

  it("replaces the whole record when Yahoo re-adjusts for a new split", async () => {
    const { service, securities, advance, upstream } = setup({ splitApplied: false });
    await service.register(["sec-285a"]);
    const before = unpackHistory("sec-285a", (await service.history("2026-01-01")).records["sec-285a"]);
    expect(before.splits).toEqual([]);
    expect(before.closes[0]).toBe(54_000);

    // The split happens: Yahoo now returns closes in the new units and lists the split.
    securities["285A.T"] = kioxia(true);
    advance(13 * 3_600_000);
    await service.tick(new Budget(45));
    const after = unpackHistory("sec-285a", (await service.history("2026-01-01")).records["sec-285a"]);
    expect(after.splits).toEqual([{ date: "2026-09-29", ratio: 3 }]);
    expect(after.closes[0]).toBe(18_000);
    expect(upstream.state.byPath.get("chart:285A.T")).toBe(3); // full, incremental (rejected), full
  });

  it("appends recent closes when the adjustment basis is unchanged", async () => {
    const { service, securities, advance, upstream } = setup();
    await service.register(["sec-285a"]);
    await service.history("2026-01-01");
    securities["285A.T"].closes.push(["2026-10-06", 18_735]);
    advance(13 * 3_600_000);
    await service.tick(new Budget(45));
    const record = unpackHistory("sec-285a", (await service.history("2026-01-01")).records["sec-285a"]);
    expect(record.dates.at(-1)).toBe("2026-10-06");
    expect(record.dates[0]).toBe("2026-09-01");
    expect(upstream.state.byPath.get("chart:285A.T")).toBe(2);
  });

  it("stays within one invocation's upstream budget and schedules the rest", async () => {
    const { service, continuation } = setup();
    await service.register(["sec-285a", "sec-us-aapl"]);
    await service.tick(new Budget(3));
    expect(continuation).toHaveBeenCalled();
  });

  it("builds fund NAV quotes and distributions from Yahoo! ファイナンス", async () => {
    const { service } = setup();
    await service.register(["sec-jp-fund-02311886"]);
    const history = await service.history("2025-01-01");
    const record = unpackHistory("sec-jp-fund-02311886", history.records["sec-jp-fund-02311886"]);
    expect(record.dividends).toEqual([{ date: "2025-06-16", amount: 130 }]);
    const snapshot = await service.snapshot();
    const quote = snapshot.quotes.find((item) => item.key === "sec-jp-fund-02311886")!;
    expect(quote).toMatchObject({ venue: "FUND", price: record.closes.at(-1), previousClose: record.closes.at(-2), name: "インデックスファンド225" });
  });

  it("rejects malformed history requests", async () => {
    const { service } = setup();
    expect((await serveMarket(new Request("https://k/api/market/history?from=2026-03-05"), service, { maxRegister: 1 })).status).toBe(400);
    expect((await serveMarket(new Request("https://k/api/market/registry", { method: "POST", body: JSON.stringify({ securityIds: ["sec-1", "sec-2"] }) }), service, { maxRegister: 1 })).status).toBe(400);
  });
});
