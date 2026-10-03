import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sync/firebase-client", () => ({ getMarketAuthHeaders: async () => ({ Authorization: "Bearer synthetic" }) }));

const quote = (price: string, marketTimestamp = "2026-10-02T20:00:00.000Z") => ({
  securityId: "sec-us-aapl", symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price, previousRegularClose: "330",
  marketTimestamp, fetchedAt: marketTimestamp, freshness: "live", provider: "yahoo_spark", session: "regular", priceType: "last_trade", venueCode: "US", validationStatus: "valid",
});
const wire = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2, full: true, generatedAt: "2026-10-02T20:00:00.000Z", revision: "r1", catalogKey: "c1", failures: [],
  quotes: [quote("333")], benchmarks: [{ id: "sp500", label: "S&P 500", symbol: "^GSPC", value: 7700, changeRatio: 0.01, marketTimestamp: "2026-10-02T20:00:00.000Z", freshness: "live" }],
  series: [{ id: "sec-us-aapl", v: "yahoo_spark", t: [1_790_970_000, 300, 300], p: [332, 332.5, 333] }],
  ...overrides,
});

let requests: Request[] = [];
let responses: Array<() => Response> = [];
beforeEach(async () => {
  // Intraday retention is relative to the wall clock; pin it to the fixture day.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T20:01:00.000Z"));
  requests = [];
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(new Request(new URL(input, "https://kabutora.test"), init));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }));
  (await import("./market-client")).resetMarketClient();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const json = (body: unknown, headers: Record<string, string> = {}) => () => Response.json(body, { headers: { "X-Market-Server-Time": "2026-10-02T20:01:00.000Z", ...headers } });

describe("market snapshot client", () => {
  it("makes one symbol-free request and decodes delta-encoded charts", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire()));
    const snapshot = await fetchMarketSnapshot();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/api/market/snapshot");
    expect(new URL(requests[0].url).search).toBe("");
    expect(snapshot?.quotes[0].price).toBe("333");
    expect(snapshot?.intraday.map((bar) => [bar.timestamp, bar.price])).toEqual([
      ["2026-10-02T19:40:00.000Z", "332"],
      ["2026-10-02T19:45:00.000Z", "332.5"],
      ["2026-10-02T19:50:00.000Z", "333"],
    ]);
    expect(snapshot?.refresh.status).toBe("ready");
  });

  it("shares one request between concurrent callers", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire()));
    const [left, right] = await Promise.all([fetchMarketSnapshot(), fetchMarketSnapshot()]);
    expect(requests).toHaveLength(1);
    expect(left).toBe(right);
  });

  it("reuses a snapshot loaded moments ago instead of asking again", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire()));
    const first = await fetchMarketSnapshot();
    expect(await fetchMarketSnapshot()).toBe(first);
    expect(requests).toHaveLength(1);
  });

  it("revalidates with the revision and treats 304 as freshly verified prices", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire()));
    await fetchMarketSnapshot();
    vi.setSystemTime(new Date("2026-10-02T20:02:00.000Z"));
    responses.push(() => new Response(null, { status: 304, headers: { "X-Market-Server-Time": "2026-10-02T20:05:00.000Z", "X-Market-Generated-At": "2026-10-02T20:04:50.000Z" } }));
    const snapshot = await fetchMarketSnapshot();
    expect(requests[1].headers.get("If-None-Match")).toBe('"r1"');
    expect(new URL(requests[1].url).searchParams.get("catalog")).toBe("c1");
    expect(Number(new URL(requests[1].url).searchParams.get("since"))).toBe(1_790_970_600 - 900);
    expect(snapshot?.quotes[0].fetchedAt).toBe("2026-10-02T20:04:50.000Z");
    expect(snapshot?.intraday).toHaveLength(3);
  });

  it("merges an incremental response into the existing charts", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire()));
    await fetchMarketSnapshot();
    responses.push(json(wire({ full: false, revision: "r2", quotes: [quote("334", "2026-10-02T20:00:30.000Z")], series: [{ id: "sec-us-aapl", v: "yahoo_spark", t: [1_790_970_900], p: [334] }] })));
    const snapshot = await fetchMarketSnapshot({ force: true });
    expect(new URL(requests[1].url).searchParams.get("refresh")).toBe("1");
    expect(snapshot?.quotes[0].price).toBe("334");
    expect(snapshot?.intraday.map((bar) => bar.price)).toEqual(["332", "332.5", "333", "334"]);
  });

  it("starts from this device's saved snapshot so a reopened app usually gets a 304", async () => {
    const { fetchMarketSnapshot, restoreMarketClient } = await import("./market-client");
    responses.push(json(wire()));
    const saved = await fetchMarketSnapshot();
    const { resetMarketClient } = await import("./market-client");
    resetMarketClient();
    restoreMarketClient(Promise.resolve({ etag: "r1|c1|1790970600", snapshot: saved!, savedAt: saved!.savedAt! }));
    responses.push(() => new Response(null, { status: 304 }));
    const reopened = await fetchMarketSnapshot();
    expect(requests[1].headers.get("If-None-Match")).toBe('"r1"');
    expect(reopened?.quotes[0].price).toBe("333");
  });

  it("rejects malformed payloads instead of rendering them", async () => {
    const { fetchMarketSnapshot } = await import("./market-client");
    responses.push(json(wire({ quotes: [{ securityId: "sec-us-aapl", price: "not-a-number" }] })));
    await expect(fetchMarketSnapshot()).rejects.toThrow();
  });
});

describe("history client", () => {
  it("asks only for the earliest year and unpacks catalog rows", async () => {
    const { fetchMarketHistory } = await import("./market-client");
    responses.push(json({ generatedAt: "2026-10-02T20:00:00.000Z", from: "2021-01-01", series: { "sec-us-aapl": { provider: "fixture", rows: [["2021-01-04", "129.4", "126.8"]] } }, corporateActions: [], inceptionDates: { "sec-us-aapl": "1980-12-12" }, pending: ["sec-7203"] }));
    const history = await fetchMarketHistory("2021-06-15");
    expect(new URL(requests[0].url).searchParams.get("from")).toBe("2021-01-01");
    expect(history.bars).toEqual([{ securityId: "sec-us-aapl", date: "2021-01-04", close: "129.4", adjustedClose: "126.8", provider: "fixture" }]);
    expect(history.pending).toEqual(["sec-7203"]);
  });
});
