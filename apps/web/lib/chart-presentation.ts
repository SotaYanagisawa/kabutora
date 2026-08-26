export type DatedPoint = { date: string };

export function latestPlottedDate(points: DatedPoint[]) {
  if (!points.length) return null;
  const latest = points.reduce((current, point) => (point.date > current ? point.date : current), points[0].date);
  if (!latest.includes("T")) return /^\d{4}-\d{2}-\d{2}/u.test(latest) ? latest.slice(0, 10) : null;
  const timestamp = Date.parse(latest);
  return Number.isFinite(timestamp) ? marketDateKey(latest, "XTKS") : null;
}

export function trailingHours<T extends DatedPoint>(points: T[], hours: number) {
  const timestamps = points.map((point) => Date.parse(point.date)).filter(Number.isFinite);
  if (!timestamps.length || !Number.isFinite(hours) || hours <= 0) return [];
  const cutoff = Math.max(...timestamps) - hours * 60 * 60_000;
  return points.filter((point) => {
    const timestamp = Date.parse(point.date);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

export function sparseIntradayTimeTicks<T extends { timestamp: string }>(points: T[]): string[] {
  if (!points.length) return [];
  const lastIndex = points.length - 1;
  return [...new Set([0, Math.floor(lastIndex / 2), lastIndex])].map((index) => points[index].timestamp);
}

const TOKYO_EXCHANGES = new Set([
  "XTKS",
  "TSE",
  "JNX",
  "CHIJ",
  "JPX",
  "TYO",
  "FUK",
  "SAP",
  "NAG",
  "FUND",
  "FUND_JP",
  "JPFD",
]);

const NEW_YORK_EXCHANGES = new Set([
  "XNAS",
  "XNYS",
  "ARCX",
  "XASE",
  "IEXG",
  "BATS",
  "OTCM",
  "US",
  "INDEX",
  "INDEX_US",
  "XIND",
  "NASDAQ",
  "NYSE",
  "DJI",
  "GSPC",
  "IXIC",
]);

export function exchangeTimeZone(
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
): string {
  const mic = exchangeMic?.trim().toUpperCase();
  if (mic && TOKYO_EXCHANGES.has(mic)) return "Asia/Tokyo";
  if (mic && NEW_YORK_EXCHANGES.has(mic)) return "America/New_York";
  if (explicitTimeZone?.trim()) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: explicitTimeZone.trim() }).format(0);
      return explicitTimeZone.trim();
    } catch {}
  }
  if (currency === "JPY") return "Asia/Tokyo";
  if (currency === "USD") return "America/New_York";
  return "Asia/Tokyo";
}

export function marketDateKey(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: exchangeTimeZone(exchangeMic, explicitTimeZone, currency),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function marketTimeLabel(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: exchangeTimeZone(exchangeMic, explicitTimeZone, currency),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function marketDateTimeLabel(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: exchangeTimeZone(exchangeMic, explicitTimeZone, currency),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
