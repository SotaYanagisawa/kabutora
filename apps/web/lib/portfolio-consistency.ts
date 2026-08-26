import type { PortfolioSummary } from "@kabutora/domain";
import Decimal from "decimal.js";

/** Stock views exclude unassigned cash so ALL is exactly JP + US and brokerage slices are additive. */
export function projectStockPortfolio(summary: PortfolioSummary): PortfolioSummary {
  return {
    ...summary,
    totalValue: summary.securitiesValue,
    cashValue: "0",
    netDeposits: summary.costBasis,
    totalGain: summary.totalGain ?? String(Number(summary.unrealizedGain) + Number(summary.realizedGain)),
  };
}

export function reconcilePortfolioParts(all: PortfolioSummary, parts: PortfolioSummary[], tolerance = "0.01") {
  const fields = ["securitiesValue", "costBasis", "realizedGain", "unrealizedGain", "dayGain"] as const;
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

