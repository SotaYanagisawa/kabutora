export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isText(value: unknown, minimumLength = 0, maximumLength = 10_000): value is string {
  return typeof value === "string" && value.length >= minimumLength && value.length <= maximumLength;
}

export function isDateValue(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

/** A finite decimal string (also as a float64). `positive` is decided on the digits, so tiny values stay positive. */
export function finiteDecimal(value: unknown, positive = false): value is string {
  if (!isText(value, 1, 100) || !DECIMAL_TEXT.test(value) || !Number.isFinite(Number(value))) return false;
  if (!positive) return true;
  const mantissa = value.replace(/e.*$/iu, "");
  return !mantissa.startsWith("-") && /[1-9]/u.test(mantissa);
}
