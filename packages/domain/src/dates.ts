export type MarketTimeZone = "Asia/Tokyo" | "America/New_York";

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, value);
  }
  return value;
};

/** YYYY-MM-DD of an instant in a market's time zone. */
export function dateInZone(unixMs: number, timeZone: string): string {
  if (timeZone === "Asia/Tokyo") return new Date(unixMs + 9 * 3_600_000).toISOString().slice(0, 10);
  return formatter(timeZone).format(new Date(unixMs));
}

export const tokyoDate = (unixMs = Date.now()) => dateInZone(unixMs, "Asia/Tokyo");

/** First ten characters of an ISO date or timestamp. */
export const dateKey = (value: string) => value.slice(0, 10);

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

/** Index of the last element `<= target` in an ascending array, or -1. */
export function lastIndexAtOrBefore<T>(sorted: readonly T[], target: T): number {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= target) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
