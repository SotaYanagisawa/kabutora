import { describe, expect, it } from "vitest";
import { getEmbeddedCatalogSecurities, searchEmbeddedCatalog } from "./stock-catalog";

describe("Embedded Stock Catalog", () => {
  it("provides pre-indexed securities", () => {
    const securities = getEmbeddedCatalogSecurities();
    expect(securities.length).toBeGreaterThan(50);
  });

  it("finds Toyota by exact 4-digit code, name, kanji, kana, and alias", () => {
    for (const query of ["7203", "トヨタ", "トヨタ自動車", "とよた", "TOYOTA"]) {
      const results = searchEmbeddedCatalog(query);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].displaySymbol).toBe("7203");
      expect(results[0].name).toBe("トヨタ自動車");
    }
  });

  it("finds Apple by ticker symbol and Japanese name", () => {
    for (const query of ["AAPL", "aapl", "アップル", "Apple", "あっぷる"]) {
      const results = searchEmbeddedCatalog(query);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].displaySymbol).toBe("AAPL");
      expect(results[0].currency).toBe("USD");
    }
  });

  it("finds NVIDIA by ticker and Kana", () => {
    for (const query of ["NVDA", "エヌビディア", "えぬびでぃあ", "NVIDIA"]) {
      const results = searchEmbeddedCatalog(query);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].displaySymbol).toBe("NVDA");
    }
  });

  it("finds popular ETFs", () => {
    const spy = searchEmbeddedCatalog("SPY");
    expect(spy[0]?.displaySymbol).toBe("SPY");

    const qqq = searchEmbeddedCatalog("QQQ");
    expect(qqq[0]?.displaySymbol).toBe("QQQ");

    const topix = searchEmbeddedCatalog("1306");
    expect(topix[0]?.displaySymbol).toBe("1306");
  });
});
