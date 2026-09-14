import type { IntradayBar, MarketBar } from "@kabutora/domain";
import { validFxRate } from "./money-conversion";
export { validFxRate };

export function historicalFxRateAtDate(
  sortedBars: MarketBar[],
  date: string,
  currentRate: number | null,
  fallbackToEarliest = false,
  todayKey?: string,
): number | null {
  const key = date.slice(0, 10);
  if (!sortedBars.length) return fallbackToEarliest && validFxRate(currentRate) ? currentRate : null;
  if (todayKey && key >= todayKey && validFxRate(currentRate)) return currentRate;
  if (key > sortedBars.at(-1)!.date) return validFxRate(currentRate) ? currentRate : null;

  let low = 0;
  let high = sortedBars.length - 1;
  let match: MarketBar | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedBars[middle].date <= key) {
      match = sortedBars[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (todayKey && match?.date === todayKey && validFxRate(currentRate)) {
    return currentRate;
  }

  const rate = Number(match?.close ?? Number.NaN);
  if (validFxRate(rate)) return rate;
  if (fallbackToEarliest) {
    const earliestRate = Number(sortedBars[0]?.close ?? Number.NaN);
    if (validFxRate(earliestRate)) return earliestRate;
    return validFxRate(currentRate) ? currentRate : null;
  }
  return null;
}

export function historicalFxRateAtTimestamp(
  sortedIntradayBars: IntradayBar[],
  sortedDailyBars: MarketBar[],
  timestamp: string,
  currentRate: number | null,
  fallbackToEarliest = false,
  todayKey?: string,
): number | null {
  if (!timestamp.includes("T")) {
    return historicalFxRateAtDate(sortedDailyBars, timestamp, currentRate, fallbackToEarliest, todayKey);
  }

  if (sortedIntradayBars.length > 0) {
    if (timestamp > sortedIntradayBars.at(-1)!.timestamp) {
      if (validFxRate(currentRate)) return currentRate;
      const latestIntradayPrice = Number(sortedIntradayBars.at(-1)!.price);
      if (validFxRate(latestIntradayPrice)) return latestIntradayPrice;
    }

    let low = 0;
    let high = sortedIntradayBars.length - 1;
    let match: IntradayBar | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (sortedIntradayBars[middle].timestamp <= timestamp) {
        match = sortedIntradayBars[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (match) {
      const matchTime = Date.parse(match.timestamp);
      const targetTime = Date.parse(timestamp);
      const diffMs = Math.abs(targetTime - matchTime);
      if (Number.isFinite(diffMs) && diffMs <= 72 * 60 * 60 * 1000) {
        const rate = Number(match.price);
        if (validFxRate(rate)) return rate;
      }
    }

    if (timestamp < sortedIntradayBars[0].timestamp) {
      return historicalFxRateAtDate(sortedDailyBars, timestamp, currentRate, fallbackToEarliest, todayKey);
    }
    if (validFxRate(currentRate)) return currentRate;
  }

  return historicalFxRateAtDate(sortedDailyBars, timestamp, currentRate, fallbackToEarliest, todayKey);
}

export function lookupFxRate({
  dateOrTimestamp,
  intradayBars = [],
  dailyBars = [],
  currentRate = null,
  fallbackToEarliest = false,
  todayKey,
}: {
  dateOrTimestamp: string;
  intradayBars?: IntradayBar[];
  dailyBars?: MarketBar[];
  currentRate?: number | null;
  fallbackToEarliest?: boolean;
  todayKey?: string;
}): number | null {
  return dateOrTimestamp.includes("T")
    ? historicalFxRateAtTimestamp(intradayBars, dailyBars, dateOrTimestamp, currentRate, fallbackToEarliest, todayKey)
    : historicalFxRateAtDate(dailyBars, dateOrTimestamp, currentRate, fallbackToEarliest, todayKey);
}
