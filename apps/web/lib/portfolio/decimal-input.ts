/**
 * Keep editing drafts such as "." and "-" in the input without passing them to accounting.
 * Returns a finite number or null.
 */
export function parseDecimalInput(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized || normalized.length > 100 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stores a computed amount as a decimal string without binary noise (15 significant digits). */
export const decimalText = (value: number) => String(Number(value.toPrecision(15)));
