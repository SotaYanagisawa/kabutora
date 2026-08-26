import { describe, expect, it } from "vitest";
import { tokyoQuoteProviderOrder } from "./tokyo-quote-provider";

describe("Tokyo quote provider order", () => {
  it("prefers the PTS-capable page but falls back to the chart feed during PTS sessions", () => {
    expect(tokyoQuoteProviderOrder("pts_day")).toEqual(["yahoo_japan", "yahoo_chart"]);
    expect(tokyoQuoteProviderOrder("pts_night")).toEqual(["yahoo_japan", "yahoo_chart"]);
  });

  it("prefers the chart feed during the regular session", () => {
    expect(tokyoQuoteProviderOrder("regular")).toEqual(["yahoo_chart", "yahoo_japan"]);
    expect(tokyoQuoteProviderOrder("closed")).toEqual(["yahoo_chart", "yahoo_japan"]);
  });
});
