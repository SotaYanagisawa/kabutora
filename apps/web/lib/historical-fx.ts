import type { MarketBar } from "@kabutora/domain";

const validRate = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 50 && value <= 300;

export function historicalFxRateAtDate(sortedBars: MarketBar[], date: string, currentRate: number | null) {
  const key = date.slice(0, 10);
  if (!sortedBars.length) return null;
  if (key > sortedBars.at(-1)!.date) return validRate(currentRate) ? currentRate : null;
  let low = 0;
  let high = sortedBars.length - 1;
  let match: MarketBar | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedBars[middle].date <= key) {
      match = sortedBars[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  const rate = Number(match?.close ?? Number.NaN);
  return validRate(rate) ? rate : null;
}

