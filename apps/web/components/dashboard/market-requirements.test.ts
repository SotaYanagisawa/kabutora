import { describe, expect, it } from "vitest";
import {
  distributionSecurityIdList,
  historyCoverageRequirements,
  historyRequirementSignature,
  historySecurityIdList,
  quoteRecordWithVariants,
  quoteSecurityIdList,
} from "./market-requirements";
import type { RemoteQuote, SearchSecurity, Seed } from "./types";

const trade = (securityId: string, tradeDate: string, tradeCurrency = "JPY") => ({ id: `t-${securityId}-${tradeDate}`, securityId, tradeDate, tradeCurrency }) as Seed["transactions"][number];
const watch = (id: string) => ({ id }) as SearchSecurity;

describe("market requirements", () => {
  it("requests quotes for holdings, watchlist, the open detail page and USD/JPY, sorted and deduplicated", () => {
    expect(quoteSecurityIdList(["sec-7203", "sec-us-aapl"], [watch("sec-7203"), watch("sec-6758")], "sec-9984")).toBe("sec-6758,sec-7203,sec-9984,sec-fx-usdjpy,sec-us-aapl");
    expect(quoteSecurityIdList([], [], "")).toBe("sec-fx-usdjpy");
  });

  it("adds FX history only when needed", () => {
    const transactions = [trade("sec-7203", "2024-01-05")];
    expect(historySecurityIdList(transactions, [], false, "")).toBe("sec-7203");
    expect(historySecurityIdList(transactions, [watch("sec-6758")], true, "sec-9984")).toBe("sec-6758,sec-7203,sec-9984,sec-fx-usdjpy");
  });

  it("excludes FX pseudo-securities from distribution requests", () => {
    expect(distributionSecurityIdList([trade("sec-7203", "2024-01-05"), trade("sec-fx-usdjpy", "2024-01-05"), trade("sec-7203", "2024-02-05")])).toBe("sec-7203");
  });

  it("requires history from the first trade, one year for watchlist items and back to the earliest need for FX", () => {
    const requirements = historyCoverageRequirements(
      [trade("sec-7203", "2024-03-01T09:00:00Z"), trade("sec-7203", "2023-06-01"), trade("sec-us-aapl", "2024-01-10", "USD")],
      [watch("sec-7203"), watch("sec-6758")],
      "",
      true,
      "2026-10-02",
    );
    expect(requirements.get("sec-7203")).toBe("2023-06-01");
    expect(requirements.get("sec-us-aapl")).toBe("2024-01-10");
    expect(requirements.get("sec-6758")! < "2026-01-01").toBe(true);
    expect(requirements.get("sec-fx-usdjpy")).toBe("2023-06-01");
    expect(historyRequirementSignature(requirements, "2026-10-02")).toContain("sec-7203:2023-06-01");
  });

  it("falls back to today for FX history when nothing else needs history", () => {
    expect(historyCoverageRequirements([], [], "", true, "2026-10-02").get("sec-fx-usdjpy")).toBe("2026-10-02");
  });

  it("exposes quotes under every equivalent security ID", () => {
    const quote = { securityId: "sec-7203", price: "3000" } as RemoteQuote;
    const record = quoteRecordWithVariants([quote]);
    expect(record["sec-7203"]).toBe(quote);
    const variants = Object.keys(record).filter((id) => id !== "sec-7203");
    expect(variants.length).toBeGreaterThan(0);
    for (const id of variants) expect(record[id]).toMatchObject({ securityId: id, price: "3000" });
  });
});
