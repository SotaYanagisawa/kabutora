import { describe, expect, it } from "vitest";
import { normalizeYahooUsdQuote } from "./usd-security";

describe("USD security normalization", () => {
  it("accepts Yahoo-listed USD mutual funds with per-unit NAV pricing", () => {
    expect(normalizeYahooUsdQuote({ symbol: "VFIAX", quoteType: "MUTUALFUND", exchange: "NAS", longname: "Vanguard 500 Index Fund" })).toMatchObject({
      id: "sec-us-fund-vfiax", assetType: "fund", currency: "USD", exchangeMic: "XFND", priceUnit: "1",
    });
  });

  it("accepts USD indexes with a reversible canonical ID", () => {
    expect(normalizeYahooUsdQuote({ symbol: "^GSPC", quoteType: "INDEX", exchange: "SNP", longname: "S&P 500" })).toMatchObject({
      id: "sec-us-index-5e47535043", assetType: "index", currency: "USD", exchangeMic: "XIND",
    });
  });

  it("covers additional US stock and ETF venues", () => {
    expect(normalizeYahooUsdQuote({ symbol: "SPYI", quoteType: "ETF", exchange: "BTS", longname: "NEOS S&P 500 High Income ETF" })).toMatchObject({ exchangeMic: "BATS", currency: "USD" });
    expect(normalizeYahooUsdQuote({ symbol: "BRK-B", quoteType: "EQUITY", exchange: "NYQ", longname: "Berkshire Hathaway Inc." })).toMatchObject({ exchangeMic: "XNYS", currency: "USD" });
  });

  it("rejects futures and non-US listings rather than mislabeling them USD", () => {
    expect(normalizeYahooUsdQuote({ symbol: "ES=F", quoteType: "FUTURE", exchange: "CME", longname: "E-mini S&P 500" })).toBeNull();
    expect(normalizeYahooUsdQuote({ symbol: "VFV.TO", quoteType: "ETF", exchange: "TOR", longname: "Vanguard S&P 500 Index ETF" })).toBeNull();
    expect(normalizeYahooUsdQuote({ symbol: "^N225", quoteType: "INDEX", exchange: "OSA", longname: "Nikkei 225" })).toBeNull();
  });
});
