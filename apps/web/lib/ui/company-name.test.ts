import { describe, expect, it } from "vitest";
import { companyDisplayName, companyLegalName, shortSecurityDisplayName } from "./company-name";

describe("companyDisplayName", () => {
  it("uses a provider alias without a company-specific hardcoded rule", () => {
    const company = {
      name: "Space Exploration Technologies Corp.",
      shortName: "SpaceX",
      longName: "Space Exploration Technologies Corp.",
      country: "US",
    };

    expect(companyDisplayName(company)).toBe("SpaceX");
    expect(companyLegalName(company)).toBe("Space Exploration Technologies Corp.");
  });

  it("prefers a verified knowledge-graph brand over a verbose provider short name", () => {
    expect(companyDisplayName({
      name: "Space Exploration Technologies Corp.",
      brandName: "SpaceX",
      shortName: "Space Exploration Technologies",
      longName: "Space Exploration Technologies Corp.",
      country: "US",
    })).toBe("SpaceX");
  });

  it("removes generic legal suffixes when no provider alias exists", () => {
    expect(companyDisplayName({
      name: "Taiwan Semiconductor Manufacturing Company Limited",
      country: "US",
    })).toBe("Taiwan Semiconductor Manufacturing");
  });

  it("does not alter Japanese security names in companyDisplayName", () => {
    expect(companyDisplayName({ name: "トヨタ自動車(株)", exchangeMic: "XTKS" })).toBe("トヨタ自動車(株)");
  });
});

describe("shortSecurityDisplayName", () => {
  it("uses ticker symbol for US stocks", () => {
    expect(shortSecurityDisplayName({
      name: "Apple Inc.",
      displaySymbol: "AAPL",
      isUs: true,
    })).toBe("AAPL");

    expect(shortSecurityDisplayName({
      name: "NVIDIA Corporation",
      displaySymbol: "NVDA",
      isUs: true,
    })).toBe("NVDA");
  });

  it("shortens Japanese stock names like Kioxia and Recruit", () => {
    expect(shortSecurityDisplayName({
      name: "キオクシアホールディングス",
      displaySymbol: "285A",
      isUs: false,
    })).toBe("キオクシア");

    expect(shortSecurityDisplayName({
      name: "リクルートホールディングス",
      displaySymbol: "6098",
      isUs: false,
    })).toBe("リクルート");

    expect(shortSecurityDisplayName({
      name: "野村ホールディングス",
      displaySymbol: "8604",
      isUs: false,
    })).toBe("野村HD");

    expect(shortSecurityDisplayName({
      name: "三菱UFJフィナンシャル・グループ",
      displaySymbol: "8306",
      isUs: false,
    })).toBe("三菱UFJ");

    expect(shortSecurityDisplayName({
      name: "三井住友フィナンシャルグループ",
      displaySymbol: "8316",
      isUs: false,
    })).toBe("三井住友FG");

    expect(shortSecurityDisplayName({
      name: "トヨタ自動車株式会社",
      displaySymbol: "7203",
      isUs: false,
    })).toBe("トヨタ自動車");
  });

  it("shortens Japanese fund names", () => {
    expect(shortSecurityDisplayName({
      name: "eMAXIS Slim 全世界株式（オール・カントリー）",
      displaySymbol: "0331418A",
      isUs: false,
      isFund: true,
    })).toBe("eMAXIS Slim 全世界株式");

    expect(shortSecurityDisplayName({
      name: "＜購入・換金手数料なし＞ニッセイ外国株式インデックスファンド",
      displaySymbol: "2931113B",
      isUs: false,
      isFund: true,
    })).toBe("ニッセイ外国株式");
  });
});
