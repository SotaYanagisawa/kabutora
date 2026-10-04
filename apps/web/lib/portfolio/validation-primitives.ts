import { Decimal } from "@kabutora/domain";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isText(value: unknown, minimumLength = 0, maximumLength = 10_000): value is string {
  return typeof value === "string" && value.length >= minimumLength && value.length <= maximumLength;
}

export function isDateValue(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Plain unsigned decimals of at most 15+15 digits: always finite, and non-zero exactly when a digit is. */
const plainDecimal = /^\d{1,15}(?:\.\d{0,15})?$/u;

export function finiteDecimal(value: unknown, positive = false): value is string {
  if (!isText(value, 1, 100)) return false;
  // Market payloads hold tens of thousands of plain prices; skip a Decimal allocation for each.
  if (plainDecimal.test(value)) return !positive || /[1-9]/u.test(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return false;
  try {
    const number = new Decimal(value);
    return number.isFinite() && Number.isFinite(number.toNumber()) && (!positive || number.gt(0));
  } catch {
    return false;
  }
}
