import type { PortfolioSummary } from "@kabutora/domain";
import { Decimal } from "@kabutora/domain";

/** Stock views exclude unassigned cash so ALL is exactly JP + US and brokerage slices are additive. */
export function projectStockPortfolio(summary: PortfolioSummary | null | undefined): PortfolioSummary {
  if (!summary) {
    return {
      holdings: [],
      securitiesValue: "0",
      cashValue: "0",
      totalValue: "0",
      costBasis: "0",
      capitalRealizedGain: "0",
      distributionIncome: "0",
      realizedGain: "0",
      unrealizedGain: "0",
      totalGain: "0",
      dayGain: "0",
      netDeposits: "0",
      pricedSecurityCount: 0,
      unpricedSecurityCount: 0,
      quoteCoveragePercent: "0",
    };
  }
  const unrealized = summary.unrealizedGain ? new Decimal(summary.unrealizedGain) : new Decimal(0);
  const realized = summary.realizedGain ? new Decimal(summary.realizedGain) : new Decimal(0);
  return {
    ...summary,
    totalValue: summary.securitiesValue ?? "0",
    cashValue: "0",
    netDeposits: summary.costBasis ?? "0",
    totalGain: summary.totalGain ?? unrealized.plus(realized).toString(),
  };
}

export function reconcilePortfolioParts(all: PortfolioSummary, parts: PortfolioSummary[], tolerance = "0.01") {
  const fields = ["securitiesValue", "costBasis", "capitalRealizedGain", "distributionIncome", "realizedGain", "unrealizedGain", "dayGain"] as const;
  const differences = fields.map((field) => ({
    field,
    difference: new Decimal(all[field]).minus(parts.reduce((total, part) => total.plus(part[field]), new Decimal(0))),
  }));
  const invalid = differences.filter((item) => item.difference.abs().gt(tolerance));
  return {
    valid: invalid.length === 0,
    differences: invalid.map((item) => ({ field: item.field, difference: item.difference.toString() })),
  };
}
