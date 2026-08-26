import { describe, expect, it } from "vitest";
import type { PortfolioSummary } from "@kabutora/domain";
import { projectStockPortfolio, reconcilePortfolioParts } from "./portfolio-consistency";

const summary = (securitiesValue: string, costBasis: string, realizedGain: string, unrealizedGain: string): PortfolioSummary => ({
  holdings: [], securitiesValue, cashValue: "-999", totalValue: "-999", costBasis, realizedGain, unrealizedGain,
  totalGain: String(Number(realizedGain) + Number(unrealizedGain)),
  dayGain: "0", netDeposits: "0", pricedSecurityCount: 1, unpricedSecurityCount: 0, quoteCoveragePercent: "100",
});

describe("portfolio consistency", () => {
  it("uses the same additive valuation definition for ALL and market slices", () => {
    const jp = summary("1200", "1000", "20", "200");
    const us = summary("2400", "2000", "40", "400");
    const all = summary("3600", "3000", "60", "600");
    expect(projectStockPortfolio(all)).toMatchObject({ totalValue: "3600", cashValue: "0", netDeposits: "3000" });
    expect(reconcilePortfolioParts(all, [jp, us])).toEqual({ valid: true, differences: [] });
  });

  it("reports a mismatch instead of presenting incomplete totals as valid", () => {
    const result = reconcilePortfolioParts(summary("3500", "3000", "60", "500"), [summary("1200", "1000", "20", "200"), summary("2400", "2000", "40", "400")]);
    expect(result.valid).toBe(false);
    expect(result.differences.map((item) => item.field)).toEqual(["securitiesValue", "unrealizedGain"]);
  });
});
