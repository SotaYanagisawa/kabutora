import { Decimal } from "@kabutora/domain";

// Keep editing drafts such as "." and "-" in the input without passing them
// to Decimal or accounting. Presentation must also remain a finite number.
export function parseDecimalInput(value: string): Decimal | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized || normalized.length > 100 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalized)) return null;
  try {
    const parsed = new Decimal(normalized);
    return parsed.isFinite() && Number.isFinite(parsed.toNumber()) ? parsed : null;
  } catch { return null; }
}
