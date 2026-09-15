import { describe, expect, it, vi } from "vitest";
import {
  fetchCnbcBatchQuotes,
  fetchCnbcQuote,
  mapYahooSymbolToCnbc,
  parseCnbcQuote,
  type CnbcRawQuote,
} from "./cnbc-quote-provider";

describe("cnbc-quote-provider symbol mapping", () => {
  it("maps Yahoo benchmark and class-share symbols to CNBC symbols", () => {
    expect(mapYahooSymbolToCnbc("^GSPC")).toBe(".SPX");
    expect(mapYahooSymbolToCnbc("^IXIC")).toBe(".IXIC");
    expect(mapYahooSymbolToCnbc("^DJI")).toBe(".DJI");
    expect(mapYahooSymbolToCnbc("BRK-B")).toBe("BRK.B");
    expect(mapYahooSymbolToCnbc("BF-B")).toBe("BF.B");
    expect(mapYahooSymbolToCnbc("AAPL")).toBe("AAPL");
    expect(mapYahooSymbolToCnbc("spy")).toBe("SPY");
  });
});

describe("cnbc-quote-provider quote parsing", () => {
  const sampleRaw: CnbcRawQuote = {
    symbol: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    shortName: "SPY",
    last: "773.17",
    last_time: "2026-09-03T16:10:00.000-0400",
    open: "767.90",
    high: "774.03",
    low: "767.45",
    change: "+8.01",
    currencyCode: "USD",
    previous_day_closing: "765.16",
    volume: "41,234,567",
    exchange: "NYSE Arca",
    curmktstatus: "POST_MKT",
  };

  it("normalizes CNBC quote fields into MarketQuote structure", () => {
    const result = parseCnbcQuote(sampleRaw, "sec-us-spy", "US", "2026-09-04T00:00:00.000Z");
    expect(result).not.toBeNull();
    expect(result?.quote.price).toBe("773.17");
    expect(result?.quote.previousRegularClose).toBe("765.16");
    expect(result?.quote.dayOpen).toBe("767.9");
    expect(result?.quote.dayHigh).toBe("774.03");
    expect(result?.quote.dayLow).toBe("767.45");
    expect(result?.quote.dayVolume).toBe("41234567");
    expect(result?.quote.provider).toBe("cnbc_rest:fallback");
    expect(result?.quote.session).toBe("after_hours");
    expect(result?.quote.venueCode).toBe("US");
    expect(result?.quote.validationStatus).toBe("valid");
    expect(result?.shortName).toBe("SPY");
    expect(result?.longName).toBe("SPDR S&P 500 ETF Trust");
    expect(result?.exchangeLabel).toBe("NYSE Arca");
  });

  it("marks quotes with extreme price variation as suspect", () => {
    const suspectRaw: CnbcRawQuote = {
      ...sampleRaw,
      last: "1200.00", // > 35% jump from 765.16
    };
    const result = parseCnbcQuote(suspectRaw, "sec-us-spy", "US");
    expect(result?.quote.validationStatus).toBe("suspect");
  });

  it("maps trading sessions accurately", () => {
    expect(parseCnbcQuote({ ...sampleRaw, curmktstatus: "REG_MKT" }, "s", "US")?.quote.session).toBe("regular");
    expect(parseCnbcQuote({ ...sampleRaw, curmktstatus: "PRE_MKT" }, "s", "US")?.quote.session).toBe("pre_market");
    expect(parseCnbcQuote({ ...sampleRaw, curmktstatus: "POST_MKT" }, "s", "US")?.quote.session).toBe("after_hours");
    expect(parseCnbcQuote({ ...sampleRaw, curmktstatus: "CLOSED" }, "s", "US")?.quote.session).toBe("closed");
  });

  it("rejects invalid quotes with missing or non-positive price", () => {
    expect(parseCnbcQuote({ ...sampleRaw, last: "0" }, "s", "US")).toBeNull();
    expect(parseCnbcQuote({ ...sampleRaw, last: "-50" }, "s", "US")).toBeNull();
    expect(parseCnbcQuote({ ...sampleRaw, last: "N/A" }, "s", "US")).toBeNull();
    expect(parseCnbcQuote({ ...sampleRaw, last: undefined }, "s", "US")).toBeNull();
  });
});

describe("cnbc-quote-provider fetch functions", () => {
  it("fetches single quote via mock", async () => {
    const mockPayload = {
      FormattedQuoteResult: {
        FormattedQuote: [
          {
            symbol: "AAPL",
            last: "328.21",
            previous_day_closing: "324.96",
            curmktstatus: "REG_MKT",
            exchange: "NASDAQ",
          },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => mockPayload,
    } as any));

    try {
      const result = await fetchCnbcQuote("AAPL", "sec-us-aapl", "US");
      expect(result.quote.price).toBe("328.21");
      expect(result.quote.session).toBe("regular");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches batch quotes and maps to uppercase symbols", async () => {
    const mockPayload = {
      FormattedQuoteResult: {
        FormattedQuote: [
          { symbol: "AAPL", last: "328.21" },
          { symbol: "MSFT", last: "510.50" },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => mockPayload,
    } as any));

    try {
      const map = await fetchCnbcBatchQuotes(["aapl", "msft"]);
      expect(map.size).toBe(2);
      expect(map.get("AAPL")?.last).toBe("328.21");
      expect(map.get("MSFT")?.last).toBe("510.50");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
