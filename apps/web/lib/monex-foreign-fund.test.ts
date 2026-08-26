import { describe, expect, it } from "vitest";
import { parseMonexForeignFundPage } from "./monex-foreign-fund";

describe("Monex foreign mutual fund adapter", () => {
  it("parses USD NAV history from the embedded chart payload using Tokyo dates", () => {
    const html = `<script>var chartData = [{"dt":1785942000000,"p":907.28,"pd":907.28},{"dt":1786028400000,"p":902.81,"pd":902.81},{"dt":1786287600000,"p":914.24,"pd":914.24}];</script>`;
    expect(parseMonexForeignFundPage(html, "sec-foreign-fund-21070062")).toEqual({
      latestPrice: 914.24,
      previousPrice: 902.81,
      priceDate: "2026-08-10",
      bars: [
        { securityId: "sec-foreign-fund-21070062", date: "2026-08-06", close: "907.28", provider: "monex_foreign_fund_unofficial" },
        { securityId: "sec-foreign-fund-21070062", date: "2026-08-07", close: "902.81", provider: "monex_foreign_fund_unofficial" },
        { securityId: "sec-foreign-fund-21070062", date: "2026-08-10", close: "914.24", provider: "monex_foreign_fund_unofficial" },
      ],
    });
  });

  it("rejects missing and malformed chart data", () => {
    expect(parseMonexForeignFundPage("<html/>", "sec-foreign-fund-21070062")).toBeNull();
    expect(parseMonexForeignFundPage("<script>var chartData = nope;</script>", "sec-foreign-fund-21070062")).toBeNull();
  });
});
