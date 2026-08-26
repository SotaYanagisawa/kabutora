import { describe, expect, it } from "vitest";
import { marketDisplayName } from "./market-label";

describe("market display names", () => {
  it("uses concise U.S. exchange names from MIC codes", () => {
    expect(marketDisplayName({ exchangeMic: "XNAS" })).toBe("NASDAQ");
    expect(marketDisplayName({ exchangeMic: "XNYS" })).toBe("NYSE");
    expect(marketDisplayName({ exchangeMic: "ARCX" })).toBe("NYSE Arca");
    expect(marketDisplayName({ exchangeMic: "XASE" })).toBe("NYSE American");
    expect(marketDisplayName({ exchangeMic: "BATS" })).toBe("Cboe BZX");
    expect(marketDisplayName({ exchangeMic: "OTCM" })).toBe("OTC Markets");
    expect(marketDisplayName({ exchangeMic: "XIND" })).toBe("株価指数");
  });

  it("uses the current Tokyo Stock Exchange segment from quote metadata", () => {
    expect(marketDisplayName({ exchangeMic: "XTKS", quote: { exchangeLabel: "東証PRM" } })).toBe("東証P");
    expect(marketDisplayName({ exchangeMic: "XTKS", quote: { exchangeLabel: "東証GRT" } })).toBe("東証G");
    expect(marketDisplayName({ exchangeMic: "XTKS", exchangeLabel: "東証スタンダード" })).toBe("東証S");
  });

  it("formats major global exchanges and falls back to raw code when unknown", () => {
    expect(marketDisplayName({ exchangeMic: "XTKS" })).toBe("東証");
    expect(marketDisplayName({ exchangeMic: "XLON" })).toBe("ロンドン (LSE)");
    expect(marketDisplayName({ exchangeMic: "XKRX" })).toBe("韓国 (KRX)");
    expect(marketDisplayName({ exchangeMic: "XETR" })).toBe("ドイツ (XETRA)");
    expect(marketDisplayName({ exchangeMic: "XHKG" })).toBe("香港 (HKEX)");
    expect(marketDisplayName({ exchangeMic: "XFOOBAR" })).toBe("XFOOBAR");
  });
});
