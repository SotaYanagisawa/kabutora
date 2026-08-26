import { describe, expect, it } from "vitest";
import { parseYahooJapanFundHistory, parseYahooJapanFundPage, parseYahooJapanFundSearch } from "./yahoo-japan-fund";

describe("Yahoo Japan mutual fund adapter", () => {
  it("parses a fund NAV board and its page-issued token", () => {
    const html = `<script>window.__PRELOADED_STATE__={"mainFundPriceBoard":{"fundPrices":{"marketName":"投資信託","code":"02314143","name":"インデックスファンドNYダウ30(アメリカ株式)","fundNickName":"","updateDate":"08/12","price":"57,106","changePrice":"-570","changePriceRate":"-0.99"}},"pageInfo":{"jwtToken":"page-token"}}</script>`;
    expect(parseYahooJapanFundPage(html, "02314143", new Date("2026-08-13T00:00:00Z"))).toEqual({
      code: "02314143",
      name: "インデックスファンドNYダウ30(アメリカ株式)",
      price: 57106,
      previousPrice: 57676,
      priceDate: "2026-08-12",
      token: "page-token",
    });
  });

  it("normalizes daily NAV history and rejects malformed rows", () => {
    expect(parseYahooJapanFundHistory({ priceHistories: [
      { baseDate: "2026-08-11", closePrice: 56500 },
      { baseDate: "2026-08-12", closePrice: 57106 },
      { baseDate: "bad", closePrice: 1 },
    ] }, "sec-jp-fund-02314143")).toEqual([
      { securityId: "sec-jp-fund-02314143", date: "2026-08-11", close: "56500", provider: "yahoo_japan_fund_unofficial" },
      { securityId: "sec-jp-fund-02314143", date: "2026-08-12", close: "57106", provider: "yahoo_japan_fund_unofficial" },
    ]);
  });

  it("binds the parsed page to the requested fund code", () => {
    const html = `{"fundPrices":{"marketName":"投資信託","code":"48314059","name":"世界の息吹","fundNickName":"","updateDate":"08/12","price":"16,162","changePrice":"156"},"jwtToken":"token"}`;
    expect(parseYahooJapanFundPage(html, "02314143", new Date("2026-08-13T00:00:00Z"))).toBeNull();
  });

  it("discovers mutual funds without confusing exchange-listed ETFs", () => {
    const html = `{"detailLink":"https://finance.yahoo.co.jp/quote/0231O01A","code":"0231O01A","marketName":"投資信託","name":"インデックスファンド225(日本株式)"}{"detailLink":"https://finance.yahoo.co.jp/quote/1330.T","code":"1330","marketName":"東証ETF","name":"上場インデックスファンド225"}`;
    expect(parseYahooJapanFundSearch(html)).toEqual([expect.objectContaining({
      id: "sec-jp-fund-0231o01a",
      displaySymbol: "0231O01A",
      name: "インデックスファンド225(日本株式)",
      assetType: "fund",
      priceUnit: "10000",
    })]);
  });

  it("returns quote and recent daily history points in intraday bundle", async () => {
    const html = `<script>window.__PRELOADED_STATE__={"mainFundPriceBoard":{"fundPrices":{"marketName":"投資信託","code":"02314143","name":"インデックスファンドNYダウ30(アメリカ株式)","fundNickName":"","updateDate":"08/12","price":"57,106","changePrice":"-570","changePriceRate":"-0.99"}},"pageInfo":{"jwtToken":"page-token"}}</script>`;
    const historyJson = {
      priceHistories: [
        { baseDate: "2026-08-11", closePrice: 56500 },
        { baseDate: "2026-08-12", closePrice: 57106 },
      ],
    };
    const fetchMock = (await import("vitest")).vi.fn()
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(historyJson), { status: 200 }));
    (await import("vitest")).vi.stubGlobal("fetch", fetchMock);
    const { getYahooJapanFundQuoteBundle } = await import("./yahoo-japan-fund");
    const result = await getYahooJapanFundQuoteBundle("02314143", "sec-jp-fund-02314143", true);
    expect(result.quote.price).toBe("57106");
    expect(result.intraday).toHaveLength(2);
    expect(result.intraday[1]?.price).toBe("57106");
    (await import("vitest")).vi.unstubAllGlobals();
  });
});
