import { describe, expect, it } from "vitest";
import { normalizeYahooSearchQuote, parseYahooJapanSearch } from "./market-search";

describe("security search normalization", () => {
  it("maps Yahoo quotes to ledger security ids", () => {
    expect(normalizeYahooSearchQuote({ symbol: "NVDA", quoteType: "EQUITY", exchange: "NMS", longname: "NVIDIA Corporation" })).toMatchObject({ id: "sec-us-nvda-xnas", exchangeMic: "XNAS", currency: "USD" });
    expect(normalizeYahooSearchQuote({ symbol: "SPY", quoteType: "ETF", exchange: "PCX", exchDisp: "NYSEArca", shortname: "SPDR S&P 500" })).toMatchObject({ id: "sec-us-spy-arcx", assetType: "etf" });
    expect(normalizeYahooSearchQuote({ symbol: "285A.T", quoteType: "EQUITY", exchange: "JPX", longname: "KIOXIA HOLDINGS CORP" })).toMatchObject({ id: "sec-285a-xtks", currency: "JPY" });
    expect(normalizeYahooSearchQuote({ symbol: "005930.KS", quoteType: "EQUITY", exchange: "KSC", longname: "Samsung" })).toMatchObject({ exchangeMic: "XKRX", currency: "KRW", displaySymbol: "005930" });
    expect(normalizeYahooSearchQuote({ symbol: "BTC-USD", quoteType: "CRYPTOCURRENCY", exchange: "CCC" })).toBeNull();
  });

  it("parses Yahoo! ファイナンス search results for Tokyo stocks and funds", () => {
    const html = '"detailLink":"https://finance.yahoo.co.jp/quote/285A.T","code":"285A","marketName":"東証PRM","name":"キオクシアホールディングス(株)"'
      + '"detailLink":"https://finance.yahoo.co.jp/quote/0331418A","code":"0331418A","marketName":"投資信託","name":"eMAXIS Slim 全世界株式"';
    expect(parseYahooJapanSearch(html)).toEqual([
      expect.objectContaining({ id: "sec-285a-xtks", name: "キオクシアホールディングス", exchangeLabel: "東証PRM" }),
      expect.objectContaining({ id: "sec-jp-fund-0331418a", assetType: "fund", priceUnit: "10000" }),
    ]);
  });
});
