import { Decimal } from "@kabutora/domain";

export const validFxRate = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value) && value >= 50 && value <= 300;

export const validUsdJpy = validFxRate;

export function convertAmount(
  value: string | number | null | undefined,
  from: string,
  to: string,
  usdJpy: number | null | undefined,
): string | null {
  if (value == null) return null;
  const upperFrom = from ? from.toUpperCase() : "JPY";
  const upperTo = to ? to.toUpperCase() : "JPY";
  const cleaned = typeof value === "number" ? value : String(value).replaceAll(",", "").trim();
  if (cleaned === "" || !Number.isFinite(Number(cleaned))) return null;
  const amount = new Decimal(cleaned);
  if (!amount.isFinite()) return null;
  if (upperFrom === upperTo || upperTo === "NATIVE") return amount.toString();
  if (!validFxRate(usdJpy) || !["USD", "JPY"].includes(upperFrom) || !["USD", "JPY"].includes(upperTo)) return null;
  return (upperFrom === "USD" ? amount.mul(usdJpy) : amount.div(usdJpy)).toString();
}

export const convertMoney = convertAmount;
