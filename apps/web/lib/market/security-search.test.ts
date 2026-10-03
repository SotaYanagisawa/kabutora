import { describe, expect, it } from "vitest";
import {
  buildSecuritySearchIndex,
  isCurrentSearchRequest,
  mergeSecuritySearchResults,
  normalizeSecuritySearchTerm,
  searchSecurityIndex,
} from "./security-search";

const securities = [
  {
    id: "sec-name-aapl",
    displaySymbol: "ZZZZ",
    name: "AAPL Holdings",
    providerSymbols: { yahoo: "ZZZZ" },
  },
  {
    id: "sec-aapl",
    displaySymbol: "AAPL",
    name: "Apple Inc.",
    aliases: ["アップル"],
    readingKana: "あっぷる",
    providerSymbols: { yahoo: "AAPL" },
  },
  {
    id: "sec-aapx",
    displaySymbol: "AAPX",
    name: "AAPX ETF",
    providerSymbols: { yahoo: "AAPX" },
  },
] as const;

describe("security search indexing", () => {
  const index = buildSecuritySearchIndex(securities);

  it("normalizes width, punctuation, kana, case, and dividend spelling", () => {
    expect(normalizeSecuritySearchTerm(" ＡＰＰＬＥ・高配当（株） ")).toBe("apple好配当株");
    expect(normalizeSecuritySearchTerm("アップル")).toBe("あっぷる");
  });

  it("ranks exact symbols ahead of name and prefix matches", () => {
    expect(searchSecurityIndex(index, "AAPL").map((item) => item.id)).toEqual([
      "sec-aapl",
      "sec-name-aapl",
    ]);
    expect(searchSecurityIndex(index, "AAP").map((item) => item.id)).toEqual([
      "sec-aapl",
      "sec-aapx",
      "sec-name-aapl",
    ]);
  });

  it("finds the same security through katakana, hiragana, and aliases", () => {
    for (const query of ["アップル", "あっぷる"]) {
      expect(searchSecurityIndex(index, query)[0]?.id).toBe("sec-aapl");
    }
  });

  it("deduplicates indexed and merged results before enforcing limits", () => {
    const duplicatedIndex = buildSecuritySearchIndex([...securities, securities[1]]);
    expect(searchSecurityIndex(duplicatedIndex, "AAPL").filter((item) => item.id === "sec-aapl")).toHaveLength(1);

    const remote = { ...securities[1], name: "Remote Apple" };
    expect(mergeSecuritySearchResults([[securities[1]], [remote, securities[2]]], 2)).toEqual([
      securities[1],
      securities[2],
    ]);
    expect(mergeSecuritySearchResults([[securities[1], securities[2]]], 1)).toEqual([securities[1]]);
  });

  it("accepts only the latest generation and query", () => {
    expect(isCurrentSearchRequest(4, "nvda", 4, "nvda")).toBe(true);
    expect(isCurrentSearchRequest(3, "aapl", 4, "nvda")).toBe(false);
    expect(isCurrentSearchRequest(4, "aapl", 4, "nvda")).toBe(false);
  });
});
