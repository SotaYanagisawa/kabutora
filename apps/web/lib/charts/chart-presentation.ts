import type { IntradayBar, MarketBar } from "@kabutora/domain";
import { numericExtent } from "./numeric-extent";
import { japanMarketSession, usMarketSession } from "../market/market-session";

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
  const cutoff = numericExtent(timestamps)[1] - hours * 60 * 60_000;
  return points.filter((point) => {
    const timestamp = Date.parse(point.date);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

export function sanitizeDatedPoints<T extends DatedPoint & { value?: number; price?: number; dividendAdjustedValue?: number }>(
  points: T[],
  valueKey: "value" | "price" = "value",
): T[] {
  if (points.length < 3) return points;
  const result = points.map((p) => ({ ...p }));
  const n = result.length;

  const isSinglePointAnomaly = (pPrev: number, pCurr: number, pNext: number) => {
    const neighborRatio = pNext / pPrev;
    const ratioPrev = pCurr / pPrev;
    const ratioNext = pCurr / pNext;

    if (valueKey === "value") {
      // Portfolio Aggregate Level: highly sensitive to 1-point needle artifacts
      if (neighborRatio >= 0.995 && neighborRatio <= 1.005) {
        if (ratioPrev <= 0.990 && ratioNext <= 0.990) return true;
        if (ratioPrev >= 1.010 && ratioNext >= 1.010) return true;
      }
      if (neighborRatio >= 0.985 && neighborRatio <= 1.015) {
        if (ratioPrev <= 0.980 && ratioNext <= 0.980) return true;
        if (ratioPrev >= 1.020 && ratioNext >= 1.020) return true;
      }
      if (neighborRatio >= 0.96 && neighborRatio <= 1.04) {
        if (ratioPrev <= 0.96 && ratioNext <= 0.96) return true;
        if (ratioPrev >= 1.04 && ratioNext >= 1.04) return true;
      }
      if (neighborRatio >= 0.90 && neighborRatio <= 1.10) {
        if (ratioPrev <= 0.92 && ratioNext <= 0.92) return true;
        if (ratioPrev >= 1.08 && ratioNext >= 1.08) return true;
      }
      if (neighborRatio >= 0.75 && neighborRatio <= 1.33) {
        if (ratioPrev <= 0.80 && ratioNext <= 0.80) return true;
        if (ratioPrev >= 1.25 && ratioNext >= 1.25) return true;
      }
      return false;
    }

    // Security Price Level
    if (neighborRatio >= 0.94 && neighborRatio <= 1.06) {
      if (ratioPrev <= 0.965 && ratioNext <= 0.965) return true;
      if (ratioPrev >= 1.035 && ratioNext >= 1.035) return true;
    }
    if (neighborRatio >= 0.85 && neighborRatio <= 1.18) {
      if (ratioPrev <= 0.90 && ratioNext <= 0.90) return true;
      if (ratioPrev >= 1.10 && ratioNext >= 1.10) return true;
    }
    if (neighborRatio >= 0.50 && neighborRatio <= 2.00) {
      if (ratioPrev <= 0.75 && ratioNext <= 0.75) return true;
      if (ratioPrev >= 1.35 && ratioNext >= 1.35) return true;
    }
    return false;
  };

  const areTwoPointAnomalies = (pPrev: number, pCurr1: number, pCurr2: number, pNext: number) => {
    const neighborRatio = pNext / pPrev;
    const r1Prev = pCurr1 / pPrev;
    const r1Next = pCurr1 / pNext;
    const r2Prev = pCurr2 / pPrev;
    const r2Next = pCurr2 / pNext;

    if (valueKey === "value") {
      if (neighborRatio >= 0.995 && neighborRatio <= 1.005) {
        const bothDips = r1Prev <= 0.990 && r1Next <= 0.990 && r2Prev <= 0.990 && r2Next <= 0.990;
        const bothSpikes = r1Prev >= 1.010 && r1Next >= 1.010 && r2Prev >= 1.010 && r2Next >= 1.010;
        if (bothDips || bothSpikes) return true;
      }
      if (neighborRatio >= 0.985 && neighborRatio <= 1.015) {
        const bothDips = r1Prev <= 0.980 && r1Next <= 0.980 && r2Prev <= 0.980 && r2Next <= 0.980;
        const bothSpikes = r1Prev >= 1.020 && r1Next >= 1.020 && r2Prev >= 1.020 && r2Next >= 1.020;
        if (bothDips || bothSpikes) return true;
      }
      if (neighborRatio >= 0.96 && neighborRatio <= 1.04) {
        const bothDips = r1Prev <= 0.96 && r1Next <= 0.96 && r2Prev <= 0.96 && r2Next <= 0.96;
        const bothSpikes = r1Prev >= 1.04 && r1Next >= 1.04 && r2Prev >= 1.04 && r2Next >= 1.04;
        if (bothDips || bothSpikes) return true;
      }
      if (neighborRatio >= 0.90 && neighborRatio <= 1.10) {
        const bothDips = r1Prev <= 0.92 && r1Next <= 0.92 && r2Prev <= 0.92 && r2Next <= 0.92;
        const bothSpikes = r1Prev >= 1.08 && r1Next >= 1.08 && r2Prev >= 1.08 && r2Next >= 1.08;
        if (bothDips || bothSpikes) return true;
      }
      if (neighborRatio >= 0.75 && neighborRatio <= 1.33) {
        const bothDips = r1Prev <= 0.80 && r1Next <= 0.80 && r2Prev <= 0.80 && r2Next <= 0.80;
        const bothSpikes = r1Prev >= 1.25 && r1Next >= 1.25 && r2Prev >= 1.25 && r2Next >= 1.25;
        if (bothDips || bothSpikes) return true;
      }
      return false;
    }

    if (neighborRatio >= 0.94 && neighborRatio <= 1.06) {
      const bothDips = r1Prev <= 0.965 && r1Next <= 0.965 && r2Prev <= 0.965 && r2Next <= 0.965;
      const bothSpikes = r1Prev >= 1.035 && r1Next >= 1.035 && r2Prev >= 1.035 && r2Next >= 1.035;
      if (bothDips || bothSpikes) return true;
    }
    if (neighborRatio >= 0.85 && neighborRatio <= 1.18) {
      const bothDips = r1Prev <= 0.90 && r1Next <= 0.90 && r2Prev <= 0.90 && r2Next <= 0.90;
      const bothSpikes = r1Prev >= 1.10 && r1Next >= 1.10 && r2Prev >= 1.10 && r2Next >= 1.10;
      if (bothDips || bothSpikes) return true;
    }
    if (neighborRatio >= 0.50 && neighborRatio <= 2.00) {
      const bothDips = r1Prev <= 0.75 && r1Next <= 0.75 && r2Prev <= 0.75 && r2Next <= 0.75;
      const bothSpikes = r1Prev >= 1.35 && r1Next >= 1.35 && r2Prev >= 1.35 && r2Next >= 1.35;
      if (bothDips || bothSpikes) return true;
    }
    return false;
  };

  // Pass 1: Single-point isolated anomalies
  for (let i = 1; i < n - 1; i += 1) {
    const prevVal = Number(result[i - 1][valueKey]);
    const currVal = Number(result[i][valueKey]);
    const nextVal = Number(result[i + 1][valueKey]);
    if (!Number.isFinite(prevVal) || !Number.isFinite(currVal) || !Number.isFinite(nextVal) || prevVal <= 0 || nextVal <= 0) continue;

    if (isSinglePointAnomaly(prevVal, currVal, nextVal)) {
      const tPrev = Date.parse(result[i - 1].date);
      const tCurr = Date.parse(result[i].date);
      const tNext = Date.parse(result[i + 1].date);
      const alpha = tNext > tPrev ? Math.max(0, Math.min(1, (tCurr - tPrev) / (tNext - tPrev))) : 0.5;
      const repaired = prevVal + alpha * (nextVal - prevVal);
      result[i][valueKey] = (Math.round(repaired * 10000) / 10000) as unknown as T[typeof valueKey];

      if (result[i].dividendAdjustedValue != null && result[i - 1].dividendAdjustedValue != null && result[i + 1].dividendAdjustedValue != null) {
        const dPrev = Number(result[i - 1].dividendAdjustedValue);
        const dNext = Number(result[i + 1].dividendAdjustedValue);
        const dRepaired = dPrev + alpha * (dNext - dPrev);
        result[i].dividendAdjustedValue = (Math.round(dRepaired * 10000) / 10000) as unknown as T["dividendAdjustedValue"];
      }
    }
  }

  // Pass 2: Two-point consecutive isolated anomalies
  for (let i = 1; i < n - 2; i += 1) {
    const prevVal = Number(result[i - 1][valueKey]);
    const currVal1 = Number(result[i][valueKey]);
    const currVal2 = Number(result[i + 1][valueKey]);
    const nextVal = Number(result[i + 2][valueKey]);
    if (!Number.isFinite(prevVal) || !Number.isFinite(currVal1) || !Number.isFinite(currVal2) || !Number.isFinite(nextVal) || prevVal <= 0 || nextVal <= 0) continue;

    if (areTwoPointAnomalies(prevVal, currVal1, currVal2, nextVal)) {
      const tPrev = Date.parse(result[i - 1].date);
      const tNext = Date.parse(result[i + 2].date);
      const span = tNext - tPrev;
      if (span > 0) {
        const alpha1 = Math.max(0, Math.min(1, (Date.parse(result[i].date) - tPrev) / span));
        const alpha2 = Math.max(0, Math.min(1, (Date.parse(result[i + 1].date) - tPrev) / span));
        result[i][valueKey] = (Math.round((prevVal + alpha1 * (nextVal - prevVal)) * 10000) / 10000) as unknown as T[typeof valueKey];
        result[i + 1][valueKey] = (Math.round((prevVal + alpha2 * (nextVal - prevVal)) * 10000) / 10000) as unknown as T[typeof valueKey];

        if (result[i].dividendAdjustedValue != null && result[i + 1].dividendAdjustedValue != null && result[i - 1].dividendAdjustedValue != null && result[i + 2].dividendAdjustedValue != null) {
          const dPrev = Number(result[i - 1].dividendAdjustedValue);
          const dNext = Number(result[i + 2].dividendAdjustedValue);
          const d1 = dPrev + alpha1 * (dNext - dPrev);
          const d2 = dPrev + alpha2 * (dNext - dPrev);
          result[i].dividendAdjustedValue = (Math.round(d1 * 10000) / 10000) as unknown as T["dividendAdjustedValue"];
          result[i + 1].dividendAdjustedValue = (Math.round(d2 * 10000) / 10000) as unknown as T["dividendAdjustedValue"];
        }
      }
    }
  }

  // Pass 3: Edge checks (trailing and leading edges)
  if (n >= 2) {
    const lastVal = Number(result[n - 1][valueKey]);
    const secondLastVal = Number(result[n - 2][valueKey]);
    if (Number.isFinite(lastVal) && Number.isFinite(secondLastVal) && secondLastVal > 0) {
      const tailRatio = lastVal / secondLastVal;
      const isTailAnomaly = valueKey === "value"
        ? (tailRatio <= 0.85 || tailRatio >= 1.20)
        : (tailRatio <= 0.70 || tailRatio >= 1.45);
      if (isTailAnomaly) {
        result[n - 1][valueKey] = secondLastVal as unknown as T[typeof valueKey];
        if (result[n - 1].dividendAdjustedValue != null && result[n - 2].dividendAdjustedValue != null) {
          result[n - 1].dividendAdjustedValue = result[n - 2].dividendAdjustedValue;
        }
      }
    }

    const firstVal = Number(result[0][valueKey]);
    const secondVal = Number(result[1][valueKey]);
    if (Number.isFinite(firstVal) && Number.isFinite(secondVal) && secondVal > 0) {
      const leadRatio = firstVal / secondVal;
      const isLeadAnomaly = valueKey === "value"
        ? (leadRatio <= 0.85 || leadRatio >= 1.20)
        : (leadRatio <= 0.70 || leadRatio >= 1.45);
      if (isLeadAnomaly) {
        result[0][valueKey] = secondVal as unknown as T[typeof valueKey];
        if (result[0].dividendAdjustedValue != null && result[1].dividendAdjustedValue != null) {
          result[0].dividendAdjustedValue = result[1].dividendAdjustedValue;
        }
      }
    }
  }

  return result;
}

export function sparseIntradayTimeTicks<T extends { timestamp: string }>(points: T[]): string[] {
  if (!points.length) return [];
  const lastIndex = points.length - 1;
  return [...new Set([0, Math.floor(lastIndex / 2), lastIndex])].map((index) => points[index].timestamp);
}

/** A compact stock sparkline never needs more than this many rendered points. */
export const MAX_SPARKLINE_POINTS = 256;

function cappedIntradayBars(bars: IntradayBar[]): IntradayBar[] {
  const deduped = [...new Map(
    bars
      .filter((bar) => Number.isFinite(Number(bar.price)) && Number.isFinite(Date.parse(bar.timestamp)))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .map((bar) => [bar.timestamp, bar]),
  ).values()];
  if (deduped.length <= MAX_SPARKLINE_POINTS) return deduped;

  const prices = deduped.map((bar) => Number(bar.price));
  let minIndex = 0;
  let maxIndex = 0;
  for (let index = 1; index < prices.length; index += 1) {
    if (prices[index] < prices[minIndex]) minIndex = index;
    if (prices[index] > prices[maxIndex]) maxIndex = index;
  }
  const keep = new Set([0, deduped.length - 1, minIndex, maxIndex]);
  const regularSamples = Math.max(0, MAX_SPARKLINE_POINTS - keep.size);
  for (let index = 1; index <= regularSamples; index += 1) {
    keep.add(Math.round((index / (regularSamples + 1)) * (deduped.length - 1)));
  }
  return [...keep].sort((left, right) => left - right).slice(0, MAX_SPARKLINE_POINTS).map((index) => deduped[index]);
}

export function latestIntradaySessionBars(
  bars: IntradayBar[],
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
): IntradayBar[] {
  const ordered = [...bars]
    .filter((bar) => Number.isFinite(Number(bar.price)) && Number.isFinite(Date.parse(bar.timestamp)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (!ordered.length) return [];
  const latestSession = marketSessionDateKey(ordered.at(-1)!.timestamp, exchangeMic, explicitTimeZone, currency, country);
  const sessionBars = latestSession
    ? ordered.filter((bar) => marketSessionDateKey(bar.timestamp, exchangeMic, explicitTimeZone, currency, country) === latestSession)
    : ordered;
  return cappedIntradayBars(sessionBars);
}

/** Retain enough persisted data for today's curve and a previous-session fallback. */
export function recentIntradaySessionBars(
  bars: IntradayBar[],
  sessionCount = 2,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
): IntradayBar[] {
  const groups = new Map<string, IntradayBar[]>();
  for (const bar of bars) {
    const date = marketSessionDateKey(bar.timestamp, exchangeMic, explicitTimeZone, currency, country);
    if (!date || !Number.isFinite(Number(bar.price)) || !Number.isFinite(Date.parse(bar.timestamp))) continue;
    const group = groups.get(date) ?? [];
    group.push(bar);
    groups.set(date, group);
  }
  const dates = [...groups.keys()].sort().slice(-Math.max(1, sessionCount));
  return dates.flatMap((date) => cappedIntradayBars(groups.get(date) ?? []));
}

export function sparkline24HourBars(
  bars: IntradayBar[],
  options: {
    now?: Date | number | string;
    isMarketOpen?: boolean;
    exchangeMic?: string | null;
    timeZone?: string | null;
    currency?: string | null;
    country?: string | null;
    quoteTimestamp?: string | null;
  } = {},
): IntradayBar[] {
  const validBars = bars
    .filter((bar) => Number.isFinite(Number(bar.price)) && Number.isFinite(Date.parse(bar.timestamp)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (!validBars.length) return [];

  const lastBarMs = Date.parse(validBars.at(-1)!.timestamp);
  const refDate = options.now != null
    ? new Date(options.now)
    : options.quoteTimestamp
      ? new Date(options.quoteTimestamp)
      : new Date(lastBarMs);

  const tz = exchangeTimeZone(options.exchangeMic, options.timeZone, options.currency, options.country);
  const isOpen = options.isMarketOpen ?? (
    tz === "America/New_York"
      ? usMarketSession(refDate).isOpen
      : japanMarketSession(refDate).isOpen
  );

  let endMs: number;
  if (isOpen) {
    const refMs = refDate.getTime();
    endMs = Math.max(refMs, lastBarMs);
  } else {
    // If market is currently closed, show the most recent market open time as the last time in the sparkline
    const quoteMs = options.quoteTimestamp ? Date.parse(options.quoteTimestamp) : Number.NaN;
    endMs = Number.isFinite(quoteMs) && quoteMs > lastBarMs ? quoteMs : lastBarMs;
  }

  const startMs = endMs - 24 * 60 * 60 * 1000;
  const windowBars = validBars.filter((bar) => {
    const t = Date.parse(bar.timestamp);
    return t >= startMs && t <= endMs;
  });

  return cappedIntradayBars(windowBars);
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
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function dateTimeFormatter(timeZone: string) {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    dateTimeFormatters.set(timeZone, formatter);
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

export function marketSessionDateKey(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const tz = exchangeTimeZone(exchangeMic, explicitTimeZone, currency, country);
  const parts = dateTimeFormatter(tz).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  const weekday = part("weekday");

  let daysToSubtract = 0;
  if (weekday === "Sat") {
    daysToSubtract = 1;
  } else if (weekday === "Sun") {
    daysToSubtract = 2;
  } else if (tz === "Asia/Tokyo" && (hour < 6 || (hour === 6 && minute === 0))) {
    daysToSubtract = weekday === "Mon" ? 3 : 1;
  } else if (tz === "America/New_York" && hour < 4) {
    daysToSubtract = weekday === "Mon" ? 3 : 1;
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  if (daysToSubtract > 0) {
    d.setUTCDate(d.getUTCDate() - daysToSubtract);
  }
  const sYear = d.getUTCFullYear();
  const sMonth = String(d.getUTCMonth() + 1).padStart(2, "0");
  const sDay = String(d.getUTCDate()).padStart(2, "0");
  return `${sYear}-${sMonth}-${sDay}`;
}

export function exchangeTimeZoneCode(date: Date, timeZone: string): string {
  if (timeZone === "Asia/Tokyo") return "JST";
  if (timeZone === "America/New_York" || timeZone === "America/Toronto") {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "EDT" || name === "EST")) return name;
    } catch {}
    return "ET";
  }
  if (timeZone === "Europe/London") {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(date);
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
      const parts = new Intl.DateTimeFormat("en-AU", { timeZone, timeZoneName: "short" }).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "AEST" || name === "AEDT")) return name;
    } catch {}
    return "AEST";
  }
  if (["Europe/Berlin", "Europe/Paris", "Europe/Amsterdam", "Europe/Zurich", "Europe/Frankfurt"].includes(timeZone)) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(date);
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (name && (name === "CEST" || name === "CET")) return name;
    } catch {}
    return "CET";
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {}
  return timeZone;
}

export function marketTimeLabel(
  value: string,
  exchangeMic?: string | null,
  explicitTimeZone?: string | null,
  currency?: string | null,
  country?: string | null,
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return timeFormatter(exchangeTimeZone(exchangeMic, explicitTimeZone, currency, country)).format(date);
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
  const formatted = new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} ${tzCode}`;
}

export function alignIntradayToQuote(
  bars: IntradayBar[],
  quoteTimestamp?: string | null,
  currentPrice?: number | string | null,
  securityId?: string,
  provider?: string,
): IntradayBar[] {
  if (!quoteTimestamp || currentPrice == null || !Number.isFinite(Number(currentPrice))) {
    return bars;
  }
  const priceStr = String(currentPrice);
  const ordered = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lastBar = ordered.at(-1);

  if (!lastBar) {
    return [
      {
        securityId: securityId ?? bars[0]?.securityId ?? "security",
        timestamp: quoteTimestamp,
        price: priceStr,
        provider: provider ?? "quote",
      },
    ];
  }

  const matchingIndex = ordered.findIndex((bar) => bar.timestamp === quoteTimestamp);
  if (matchingIndex >= 0) {
    return ordered.map((bar, index) => index === matchingIndex ? { ...bar, price: priceStr, provider: provider ?? bar.provider } : bar);
  }

  // A closed-market quote can carry the regular close while the series already
  // contains a newer extended-hours trade. Keep that trade instead of truncating
  // the real session curve back to the close.
  if (lastBar && quoteTimestamp < lastBar.timestamp) return ordered;

  return [
    ...ordered,
    {
      securityId: securityId ?? lastBar.securityId,
      timestamp: quoteTimestamp,
      price: priceStr,
      provider: provider ?? lastBar.provider ?? "quote",
    },
  ];
}

export function shortDate(dateStr: string): string {
  const clean = dateStr.slice(0, 10);
  const [, month, day] = clean.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : "—";
}

export function computeSparklinePoints(
  values: number[],
  scaleValues: number[] = values,
  width = 120,
  paddingX = 2,
  topY = 4,
  bottomY = 40,
  xRatios?: number[],
): { points: string; y: (val: number) => number; min: number; max: number } {
  const [rawMin, rawMax] = numericExtent(scaleValues);
  const padding = Math.max((rawMax - rawMin) * 0.05, rawMax * 0.0005);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const spread = max - min || 1;
  const availableHeight = bottomY - topY;
  const y = (val: number) => bottomY - ((val - min) / spread) * availableHeight;
  const availableWidth = width - 2 * paddingX;
  const points = values
    .map((val, idx) => `${paddingX + (xRatios?.[idx] ?? idx / Math.max(1, values.length - 1)) * availableWidth},${y(val).toFixed(2)}`)
    .join(" ");
  return { points, y, min, max };
}

export type SparklineSeriesInput = {
  bars?: IntradayBar[];
  dailyBars?: MarketBar[];
  previousClose?: number | null;
  positive?: boolean;
  exchangeMic?: string | null;
  timeZone?: string | null;
  stockCurrency?: string | null;
  country?: string | null;
  asOf?: string | null;
  currentTime?: string | number | Date | null;
};

export type SparklineResolvedSeries =
  | {
      kind: "intraday_session";
      values: number[];
      timeTicks: string[];
      timeLabels: string[];
      previousClose: number | null;
      positive: boolean;
      sessionDate: string;
      isPreviousSession: boolean;
      sessionLabel: string | null;
      points: string;
      previousY: number | null;
    }
  | {
      kind: "intraday_single";
      values: number[];
      timeTicks: string[];
      timeLabels: string[];
      previousClose: null;
      positive: boolean;
      sessionDate: string;
      isPreviousSession: boolean;
      sessionLabel: string | null;
      points: string;
      previousY: null;
    }
  | {
      kind: "empty";
    };

export function resolveSparklineSeries(input: SparklineSeriesInput): SparklineResolvedSeries {
  const rawBars = input.bars ?? [];
  if (!rawBars.length) {
    return { kind: "empty" };
  }

  const tz = exchangeTimeZone(input.exchangeMic, input.timeZone, input.stockCurrency, input.country);
  const sortedRaw = [...rawBars]
    .filter((b) => Number.isFinite(Number(b.price)) && Number.isFinite(Date.parse(b.timestamp)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!sortedRaw.length) {
    return { kind: "empty" };
  }
  const lastBarMs = Date.parse(sortedRaw.at(-1)!.timestamp);
  const refDate = input.currentTime != null
    ? new Date(input.currentTime)
    : input.asOf
      ? new Date(input.asOf)
      : new Date(lastBarMs);

  const isOpen = tz === "America/New_York"
    ? usMarketSession(refDate).isOpen
    : japanMarketSession(refDate).isOpen;

  const displayBars = sparkline24HourBars(rawBars, {
    now: refDate,
    isMarketOpen: isOpen,
    exchangeMic: input.exchangeMic,
    timeZone: input.timeZone,
    currency: input.stockCurrency,
    country: input.country,
    quoteTimestamp: input.asOf,
  });

  if (!displayBars.length) {
    return { kind: "empty" };
  }

  const lastBar = displayBars.at(-1)!;
  const sessionDate = lastBar.timestamp.slice(0, 10);
  const currentDate = marketDateKey(refDate.toISOString(), input.exchangeMic, input.timeZone, input.stockCurrency, input.country);
  const isPreviousSession = !isOpen || sessionDate < currentDate;

  if (displayBars.length >= 2) {
    const values = displayBars.map((bar) => Number(bar.price));
    const displayedPreviousClose = isPreviousSession ? null : (input.previousClose ?? null);
    const scaleValues = displayedPreviousClose == null ? values : [...values, displayedPreviousClose];
    const timestamps = displayBars.map((bar) => Date.parse(bar.timestamp));
    const firstTimestamp = timestamps[0];
    const lastTimestamp = timestamps.at(-1)!;
    const span = Math.max(1, lastTimestamp - firstTimestamp);
    const xRatios = timestamps.map((timestamp) => (timestamp - firstTimestamp) / span);
    const { points, y } = computeSparklinePoints(values, scaleValues, 120, 2, 4, 40, xRatios);
    const timeTicks = sparseIntradayTimeTicks(displayBars);
    const timeLabels = timeTicks.map((t) => marketTimeLabel(t, input.exchangeMic, input.timeZone, input.stockCurrency, input.country));
    const previousY = displayedPreviousClose == null ? null : Number(y(displayedPreviousClose).toFixed(2));
    const positive = isPreviousSession
      ? values.at(-1)! >= values[0]
      : (input.positive ?? (values.at(-1)! >= (displayedPreviousClose ?? values[0])));
    return {
      kind: "intraday_session",
      values,
      timeTicks,
      timeLabels,
      previousClose: displayedPreviousClose,
      positive,
      sessionDate,
      isPreviousSession,
      sessionLabel: null,
      points,
      previousY,
    };
  }

  if (displayBars.length === 1) {
    const bar = displayBars[0];
    const currentPrice = Number(bar.price);
    const values = [currentPrice];
    const { points } = computeSparklinePoints(values, values);
    const timeTick = bar.timestamp;
    const timeLabel = marketTimeLabel(timeTick, input.exchangeMic, input.timeZone, input.stockCurrency, input.country);
    const positive = input.positive ?? (currentPrice >= (input.previousClose ?? currentPrice));
    return {
      kind: "intraday_single",
      values,
      timeTicks: [timeTick],
      timeLabels: [timeLabel],
      previousClose: null,
      positive,
      sessionDate,
      isPreviousSession,
      sessionLabel: null,
      points,
      previousY: null,
    };
  }

  return { kind: "empty" };
}
