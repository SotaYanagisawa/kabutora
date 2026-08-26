import { describe, expect, it } from "vitest";
import { featuredJapanFunds, searchKnownJapanFunds } from "./japan-fund-catalog";

describe("Japanese fund catalog", () => {
  it("keeps all explicitly supported funds visible", () => {
    expect(featuredJapanFunds().map((fund) => fund.displaySymbol)).toEqual(["48314059", "02311886", "02314143", "21070062"]);
  });

  it("finds the BlackRock fund by official name, nickname, code, and common spelling", () => {
    for (const query of ["ブラックロック 世界好配当株式オープン", "世界の息吹", "48314059", "ブラックロック世界高配当株式オープン 世界の息吹（日本円）"]) {
      expect(searchKnownJapanFunds(query)[0]).toMatchObject({ displaySymbol: "48314059", assetType: "fund", priceUnit: "10000" });
    }
  });

  it("returns both index funds for a broad fund-name query", () => {
    expect(searchKnownJapanFunds("インデックスファンド").map((fund) => fund.displaySymbol)).toEqual(["02311886", "02314143"]);
  });

  it("finds the USD-denominated Janus foreign fund by the user's short name", () => {
    expect(searchKnownJapanFunds("ジャナス・フォーティA米ドル")[0]).toMatchObject({
      id: "sec-foreign-fund-21070062",
      currency: "USD",
      exchangeMic: "XFND",
      priceUnit: "1",
      providerSymbols: { monex: "0162" },
    });
  });
});
