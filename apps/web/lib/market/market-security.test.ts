import { describe, expect, it } from "vitest";
import { globalSecurityId, normalizeRequestedSecurities, normalizeRequestedSecurity, yahooIndexSecurityId } from "./market-security";

describe("market security identifiers", () => {
  it("maps canonical JP, US, global and fund IDs to provider symbols", () => {
    expect(normalizeRequestedSecurity("sec-7203-xtks")?.providerSymbol).toBe("7203.T");
    expect(normalizeRequestedSecurity("sec-285a-xtks")?.providerSymbol).toBe("285A.T");
    expect(normalizeRequestedSecurity("sec-us-aapl-xnas")?.providerSymbol).toBe("AAPL");
    expect(normalizeRequestedSecurity("sec-us-vym")).toMatchObject({ providerSymbol: "VYM", currency: "USD", venueCode: "US" });
    expect(normalizeRequestedSecurity("sec-us-hdv")).toMatchObject({ providerSymbol: "HDV", currency: "USD", venueCode: "US" });
    expect(normalizeRequestedSecurity("sec-us-spyd-xams")).toMatchObject({ providerSymbol: "SPYD", exchangeMic: "ARCX", currency: "USD", venueCode: "US" });
    expect(normalizeRequestedSecurity("sec-fx-usdjpy")?.providerSymbol).toBe("JPY=X");
    expect(normalizeRequestedSecurity("sec-jp-fund-0231o01a")).toMatchObject({ providerSymbol: "0231O01A", exchangeMic: "JPFD", venueCode: "FUND" });
    expect(normalizeRequestedSecurity("sec-foreign-fund-21070062")).toMatchObject({ providerSymbol: "0162", exchangeMic: "XFND", currency: "USD", venueCode: "FUND" });
    expect(normalizeRequestedSecurity("sec-us-fund-vfiax")).toMatchObject({ providerSymbol: "VFIAX", exchangeMic: "XFND", currency: "USD", venueCode: "USD_FUND" });
    expect(normalizeRequestedSecurity("sec-us-index-5e47535043")).toMatchObject({ providerSymbol: "^GSPC", exchangeMic: "XIND", currency: "USD", venueCode: "INDEX" });
    expect(normalizeRequestedSecurity("sec-us-spyi-bats")).toMatchObject({ providerSymbol: "SPYI", exchangeMic: "BATS", currency: "USD", venueCode: "US" });
  });

  it("maps global exchanges to provider symbols and venues", () => {
    // UK
    const ukId = globalSecurityId("VOD.L", "XLON");
    expect(normalizeRequestedSecurity(ukId)).toMatchObject({ providerSymbol: "VOD.L", displaySymbol: "VOD", exchangeMic: "XLON", currency: "GBP", venueCode: "GLOBAL" });

    // Korea
    const krId = globalSecurityId("005930.KS", "XKRX");
    expect(normalizeRequestedSecurity(krId)).toMatchObject({ providerSymbol: "005930.KS", displaySymbol: "005930", exchangeMic: "XKRX", currency: "KRW", venueCode: "GLOBAL" });

    // Germany
    const deId = globalSecurityId("SAP.DE", "XETR");
    expect(normalizeRequestedSecurity(deId)).toMatchObject({ providerSymbol: "SAP.DE", displaySymbol: "SAP", exchangeMic: "XETR", currency: "EUR", venueCode: "GLOBAL" });

    // Hong Kong
    const hkId = globalSecurityId("0700.HK", "XHKG");
    expect(normalizeRequestedSecurity(hkId)).toMatchObject({ providerSymbol: "0700.HK", displaySymbol: "0700", exchangeMic: "XHKG", currency: "HKD", venueCode: "GLOBAL" });

    // Canada
    const caId = globalSecurityId("RY.TO", "XTSE");
    expect(normalizeRequestedSecurity(caId)).toMatchObject({ providerSymbol: "RY.TO", displaySymbol: "RY", exchangeMic: "XTSE", currency: "CAD", venueCode: "GLOBAL" });

    // Australia
    const auId = globalSecurityId("BHP.AX", "XASX");
    expect(normalizeRequestedSecurity(auId)).toMatchObject({ providerSymbol: "BHP.AX", displaySymbol: "BHP", exchangeMic: "XASX", currency: "AUD", venueCode: "GLOBAL" });

    // Global Indexes
    const ftseId = yahooIndexSecurityId("^FTSE");
    expect(normalizeRequestedSecurity(ftseId)).toMatchObject({ providerSymbol: "^FTSE", displaySymbol: "^FTSE", exchangeMic: "XIND", venueCode: "INDEX" });
    const n225Id = yahooIndexSecurityId("^N225");
    expect(normalizeRequestedSecurity(n225Id)).toMatchObject({ providerSymbol: "^N225", displaySymbol: "^N225", exchangeMic: "XIND", venueCode: "INDEX" });
  });

  it("rejects URLs, path traversal and unsupported exchange identifiers", () => {
    expect(normalizeRequestedSecurity("https://169.254.169.254/latest")).toBeNull();
    expect(normalizeRequestedSecurity("../../etc/passwd")).toBeNull();
    expect(normalizeRequestedSecurity("sec-7203-evil")).toBeNull();
    expect(normalizeRequestedSecurity("sec-us-aapl-xnas?host=evil.test")).toBeNull();
    expect(normalizeRequestedSecurity("sec-jp-fund-../../etc")).toBeNull();
    expect(normalizeRequestedSecurity("sec-us-index-2f2f6576696c")).toBeNull();
    expect(normalizeRequestedSecurity("sec-gl-2f2f6576696c-evil")).toBeNull();
  });

  it("deduplicates and limits each market request", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `sec-${String(1000 + index)}-xtks`);
    const normalized = normalizeRequestedSecurities([ids[0], ids[0], ...ids].join(","));
    expect(normalized).toHaveLength(25);
    expect(new Set(normalized.map((item) => item.id)).size).toBe(25);
  });

  it("normalizes bare Japanese tickers and .T symbols", () => {
    expect(normalizeRequestedSecurity("285A")).toMatchObject({
      id: "sec-285a",
      displaySymbol: "285A",
      providerSymbol: "285A.T",
      exchangeMic: "XTKS",
      currency: "JPY",
      venueCode: "TSE",
    });
    expect(normalizeRequestedSecurity("285A.T")).toMatchObject({
      id: "sec-285a",
      displaySymbol: "285A",
      providerSymbol: "285A.T",
    });
    expect(normalizeRequestedSecurity("7203")).toMatchObject({
      id: "sec-7203",
      displaySymbol: "7203",
      providerSymbol: "7203.T",
    });
    expect(normalizeRequestedSecurity("7203.T")).toMatchObject({
      id: "sec-7203",
      displaySymbol: "7203",
      providerSymbol: "7203.T",
    });
  });
});
