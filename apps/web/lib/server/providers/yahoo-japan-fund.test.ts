import { describe, expect, it } from "vitest";
import { parseBlackRockFundDistributions, parseYahooJapanFundDistributions, parseYahooJapanFundHistory, parseYahooJapanFundPage, parseYahooJapanFundSearch } from "./yahoo-japan-fund";

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

  it("parses the current Yahoo Next.js flight price board", () => {
    const flightData = `6:["$","provider",null,{"preloadedStore":{"pageInfo":{"code":"02314143","jwtToken":"flight-token"},"priceBoard":{"code":"02314143","name":"インデックスファンドNYダウ30(アメリカ株式)","marketName":"","price":{"value":"57,325","changePrice":"191","changePriceRate":"0.33","updateDate":"8/28"},"nickName":"NYダウ"}}}]`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightData)}])</script>`;
    expect(parseYahooJapanFundPage(html, "02314143", new Date("2026-08-28T14:00:00Z"))).toEqual({
      code: "02314143",
      name: "インデックスファンドNYダウ30(アメリカ株式)",
      nickname: "NYダウ",
      price: 57325,
      previousPrice: 57134,
      priceDate: "2026-08-28",
      token: "flight-token",
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

  it("parses Yahoo Japan fund distribution rows and deduplicates flight data", () => {
    const html = `<table aria-label="分配金実績のテーブル"><tbody><tr><td>2026/8/25</td><td><span class="_StyledNumber__value_hash">130</span><span>円</span></td></tr></tbody></table><script>self.__next_f.push([1,"{\\"date\\":\\"2026/8/25\\",\\"price\\":\\"130\\"}"])</script>`;
    expect(parseYahooJapanFundDistributions(html, "48314059", "sec-jp-fund-48314059")).toEqual([expect.objectContaining({
      id: "sec-jp-fund-48314059-fund-distribution-2026-08-25",
      exDate: "2026-08-25",
      amountPerUnit: "130",
      distributionUnit: "10000",
      currency: "JPY",
      confidence: "reported",
    })]);
  });

  it("parses the complete official BlackRock distribution table", () => {
    const payload = { table: { aaData: [
      [{ display: "2026年8月25日", raw: 20260825 }, { display: "¥130.0", raw: 130 }],
      [{ display: "2024年11月25日", raw: 20241125 }, { display: "¥110.0", raw: 110 }],
    ] } };
    expect(parseBlackRockFundDistributions(payload, "48314059", "sec-jp-fund-48314059", "https://www.blackrock.com/distributions")).toEqual([
      expect.objectContaining({ exDate: "2024-11-25", amountPerUnit: "110", sourceProvider: "blackrock_official", confidence: "official" }),
      expect.objectContaining({ exDate: "2026-08-25", amountPerUnit: "130", sourceProvider: "blackrock_official", confidence: "official" }),
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
      .mockResolvedValueOnce(new Response(html, { status: 200, headers: { "set-cookie": "A=session-a; Path=/, B=session-b; Path=/" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(historyJson), { status: 200 }));
    (await import("vitest")).vi.stubGlobal("fetch", fetchMock);
    const { getYahooJapanFundQuoteBundle } = await import("./yahoo-japan-fund");
    const result = await getYahooJapanFundQuoteBundle("02314143", "sec-jp-fund-02314143", true);
    expect(result.quote.price).toBe("57106");
    expect(result.intraday).toHaveLength(2);
    expect(result.intraday[1]?.price).toBe("57106");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/bff-quote/v1/ajax/chart/ex/v1/main/fund/chart/history/02314143");
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Cookie).toBe("A=session-a; B=session-b");
    (await import("vitest")).vi.unstubAllGlobals();
  });
});
