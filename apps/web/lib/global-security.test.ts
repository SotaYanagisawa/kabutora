import { describe, expect, it } from "vitest";
import { normalizeYahooGlobalQuote, resolveGlobalVenue } from "./global-security";

describe("global security normalizer", () => {
  it("resolves venues for major global exchanges correctly", () => {
    expect(resolveGlobalVenue("LSE", "London", "VOD.L")).toMatchObject({ mic: "XLON", country: "GB", currency: "GBP" });
    expect(resolveGlobalVenue("KSC", "KSE", "005930.KS")).toMatchObject({ mic: "XKRX", country: "KR", currency: "KRW" });
    expect(resolveGlobalVenue("GER", "XETRA", "SAP.DE")).toMatchObject({ mic: "XETR", country: "DE", currency: "EUR" });
    expect(resolveGlobalVenue("HKG", "HKSE", "0700.HK")).toMatchObject({ mic: "XHKG", country: "HK", currency: "HKD" });
    expect(resolveGlobalVenue("TOR", "Toronto", "RY.TO")).toMatchObject({ mic: "XTSE", country: "CA", currency: "CAD" });
    expect(resolveGlobalVenue("ASX", "Australian", "BHP.AX")).toMatchObject({ mic: "XASX", country: "AU", currency: "AUD" });
    expect(resolveGlobalVenue("PAR", "Paris", "MC.PA")).toMatchObject({ mic: "XPAR", country: "FR", currency: "EUR" });
    expect(resolveGlobalVenue("SIX", "Swiss", "NESN.SW")).toMatchObject({ mic: "XSWX", country: "CH", currency: "CHF" });
  });

  it("normalizes international equities and ETFs", () => {
    const samsung = normalizeYahooGlobalQuote({
      symbol: "005930.KS",
      quoteType: "EQUITY",
      exchange: "KSC",
      longname: "Samsung Electronics Co., Ltd.",
      shortname: "Samsung Electronics",
    });
    expect(samsung).toMatchObject({
      canonicalSymbol: "005930.KS",
      displaySymbol: "005930",
      assetType: "stock",
      country: "KR",
      exchangeMic: "XKRX",
      currency: "KRW",
    });

    const vwra = normalizeYahooGlobalQuote({
      symbol: "VWRA.L",
      quoteType: "ETF",
      exchange: "LSE",
      longname: "Vanguard FTSE All-World UCITS ETF",
    });
    expect(vwra).toMatchObject({
      canonicalSymbol: "VWRA.L",
      displaySymbol: "VWRA",
      assetType: "etf",
      country: "GB",
      exchangeMic: "XLON",
      currency: "GBP",
    });
  });

  it("normalizes global indexes", () => {
    const ftse = normalizeYahooGlobalQuote({
      symbol: "^FTSE",
      quoteType: "INDEX",
      shortname: "FTSE 100",
    });
    expect(ftse).toMatchObject({
      canonicalSymbol: "^FTSE",
      displaySymbol: "^FTSE",
      assetType: "index",
      country: "GB",
      currency: "GBP",
    });

    const nikkei = normalizeYahooGlobalQuote({
      symbol: "^N225",
      quoteType: "INDEX",
      shortname: "Nikkei 225",
    });
    expect(nikkei).toMatchObject({
      canonicalSymbol: "^N225",
      displaySymbol: "^N225",
      assetType: "index",
      country: "JP",
      currency: "JPY",
    });
  });

  it("normalizes Japanese stock with .T from global search", () => {
    const toyota = normalizeYahooGlobalQuote({
      symbol: "7203.T",
      quoteType: "EQUITY",
      longname: "Toyota Motor Corporation",
    });
    expect(toyota).toMatchObject({
      id: "sec-7203-xtks",
      canonicalSymbol: "7203.T",
      displaySymbol: "7203",
      country: "JP",
      currency: "JPY",
      exchangeMic: "XTKS",
    });
  });
});
