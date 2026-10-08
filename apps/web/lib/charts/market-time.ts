/** Exchange time zones and market time labels for quotes. */

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
  "XAMS",
  "ARCA",
  "AMEX",
  "XASE",
  "IEXG",
  "BATS",
  "OTCM",
  "US",
  "INDEX",
  "INDEX_US",
  "XIND",
  "USD_FUND",
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
  country?: string | null,
): string {
  const normCountry = country?.trim().toUpperCase();
  if (normCountry === "JP" || normCountry === "JPN") return "Asia/Tokyo";
  if (normCountry === "US" || normCountry === "USA") return "America/New_York";

  const mic = exchangeMic?.trim().toUpperCase();
  if (mic && TOKYO_EXCHANGES.has(mic)) return "Asia/Tokyo";
  if (mic && NEW_YORK_EXCHANGES.has(mic)) return "America/New_York";
  if (explicitTimeZone?.trim()) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: explicitTimeZone.trim() }).format(0);
      return explicitTimeZone.trim();
    } catch {}
  }
  const normCurrency = currency?.trim().toUpperCase();
  if (normCurrency === "USD") return "America/New_York";
  if (normCurrency === "JPY") return "Asia/Tokyo";
  return "Asia/Tokyo";
}

export function marketDateKey(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const tz = exchangeTimeZone(exchangeMic, explicitTimeZone, currency, country);
  return dateFormatter(tz).format(date);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function timeFormatter(timeZone: string) {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneNameFormatter = (locale: string, timeZone: string) => {
  const key = `${locale}|${timeZone}`;
  let formatter = zoneNameFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" });
    zoneNameFormatters.set(key, formatter);
  }
  return formatter;
};

export function exchangeTimeZoneCode(date: Date, timeZone: string): string {
  if (timeZone === "Asia/Tokyo") return "JST";
  if (timeZone === "America/New_York" || timeZone === "America/Toronto") {
    try {
      const parts = zoneNameFormatter("en-US", timeZone).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "EDT" || name === "EST")) return name;
    } catch {}
    return "ET";
  }
  if (timeZone === "Europe/London") {
    try {
      const parts = zoneNameFormatter("en-GB", timeZone).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "BST" || name === "GMT")) return name;
    } catch {}
    return "GMT";
  }
  if (timeZone === "Asia/Hong_Kong") return "HKT";
  if (timeZone === "Asia/Seoul") return "KST";
  if (timeZone === "Asia/Singapore") return "SGT";
  if (timeZone === "Asia/Taipei") return "CST";
  if (timeZone === "Asia/Kolkata") return "IST";
  if (timeZone === "Australia/Sydney") {
    try {
      const parts = zoneNameFormatter("en-AU", timeZone).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "AEST" || name === "AEDT")) return name;
    } catch {}
    return "AEST";
  }
  if (["Europe/Berlin", "Europe/Paris", "Europe/Amsterdam", "Europe/Zurich", "Europe/Frankfurt"].includes(timeZone)) {
    try {
      const parts = zoneNameFormatter("en-GB", timeZone).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "CEST" || name === "CET")) return name;
    } catch {}
    return "CET";
  }
  try {
    const parts = zoneNameFormatter("en-US", timeZone).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {}
  return timeZone;
}

export function marketTimeWithZoneLabel(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const tz = exchangeTimeZone(exchangeMic, explicitTimeZone, currency, country);
  const tzCode = exchangeTimeZoneCode(date, tz);
  const time = timeFormatter(tz).format(date);
  return `${time} ${tzCode}`;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function marketDateTimeLabel(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const tz = exchangeTimeZone(exchangeMic, explicitTimeZone, currency, country);
  const tzCode = exchangeTimeZoneCode(date, tz);
  let formatter = dateTimeFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    dateTimeFormatters.set(tz, formatter);
  }
  const formatted = formatter.format(date);
  return `${formatted} ${tzCode}`;
}
