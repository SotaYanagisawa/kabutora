import { describe, expect, it } from "vitest";
import { mergeBenchmarks, mergeQuoteRecords } from "./market-snapshot-merge";
import type { ServerBenchmark, ServerRemoteQuote } from "./server-market-types";

const quote = (price: string, fetchedAt: string): ServerRemoteQuote => ({
  securityId: "sec-us-aapl-xnas",
  symbol: "AAPL",
  exchangeMic: "XNAS",
  currency: "USD",
  price,
  marketTimestamp: fetchedAt,
  fetchedAt,
  freshness: "near_live",
  provider: "fixture",
  session: "regular",
  priceType: "last_trade",
  venueCode: "US",
  validationStatus: "valid",
});
const benchmark = (value: number, fetchedAt: string): ServerBenchmark => ({
  id: "usd-jpy",
  label: "USD/JPY",
  symbol: "JPY=X",
  value,
  changeRatio: null,
  marketTimestamp: fetchedAt,
  fetchedAt,
  freshness: "near_live",
});

describe("market snapshot merging", () => {
  it("keeps the newest quote regardless of whether it came from IndexedDB or the server", () => {
    const oldQuote = quote("100", "2026-08-27T15:00:00.000Z");
    const newQuote = quote("101", "2026-08-27T15:10:00.000Z");
    expect(mergeQuoteRecords({ [oldQuote.securityId]: oldQuote }, { [newQuote.securityId]: newQuote })[oldQuote.securityId].price).toBe("101");
    expect(mergeQuoteRecords({ [newQuote.securityId]: newQuote }, { [oldQuote.securityId]: oldQuote })[oldQuote.securityId].price).toBe("101");
  });

  it("keeps the quote with a newer marketTimestamp even when fetchedAt is equal", () => {
    const regularClose = { ...quote("2400", "2026-09-05T02:00:00.000Z"), marketTimestamp: "2026-09-04T06:30:00.000Z" };
    const nightPts = { ...quote("2450", "2026-09-05T02:00:00.000Z"), marketTimestamp: "2026-09-04T16:25:00.000Z" };
    expect(mergeQuoteRecords({ [regularClose.securityId]: regularClose }, { [nightPts.securityId]: nightPts })[regularClose.securityId].price).toBe("2450");
    expect(mergeQuoteRecords({ [nightPts.securityId]: nightPts }, { [regularClose.securityId]: regularClose })[regularClose.securityId].price).toBe("2450");
  });

  it("keeps the newest benchmark", () => {
    expect(mergeBenchmarks(
      [benchmark(145, "2026-08-27T15:10:00.000Z")],
      [benchmark(144, "2026-08-27T15:00:00.000Z")],
    )[0].value).toBe(145);
  });
});
