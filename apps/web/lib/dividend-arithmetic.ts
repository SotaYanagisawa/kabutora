import { Decimal } from "@kabutora/domain";

/** Existing estimated withholding model; actual broker receipts take precedence. */
export function estimateNetDividendDecimal(gross: Decimal.Value, currency: string, taxFree: boolean): Decimal {
  const afterForeignWithholding = new Decimal(gross).mul(currency === "USD" ? "0.9" : "1");
  return taxFree ? afterForeignWithholding : afterForeignWithholding.mul("0.79685");
}
