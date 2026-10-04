import type { MarketBar } from "@kabutora/domain";

export const HISTORY_START_GRACE_DAYS = 7;
export const MAX_EXPECTED_MARKET_GAP_DAYS = 14;

export type HistoryRequirement = Map<string, string>;

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

export function historyRequirementSatisfied(
  firstAvailable: string | null | undefined,
  requiredFrom: string,
  graceDays = HISTORY_START_GRACE_DAYS,
  inceptionDate?: string,
) {
  if (!firstAvailable) return false;
  if (firstAvailable <= addDays(requiredFrom, graceDays)) return true;
  return Boolean(
    inceptionDate
    && requiredFrom < inceptionDate
    && firstAvailable >= inceptionDate
    && firstAvailable <= addDays(inceptionDate, graceDays),
  );
}

export function splitSecurityIds(value: string, batchSize = Number.MAX_SAFE_INTEGER) {
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += batchSize) batches.push(ids.slice(index, index + batchSize));
  return batches;
}

export function historyCoverage(bars: MarketBar[]) {
  const result = new Map<string, { first: string; last: string; count: number }>();
  for (const bar of bars) {
    const current = result.get(bar.securityId);
    if (!current) result.set(bar.securityId, { first: bar.date, last: bar.date, count: 1 });
    else {
      current.first = current.first < bar.date ? current.first : bar.date;
      current.last = current.last > bar.date ? current.last : bar.date;
      current.count += 1;
    }
  }
  return result;
}

export function firstInternalHistoryGap(
  bars: MarketBar[],
  securityId: string,
  requiredFrom: string,
  maxGapDays = MAX_EXPECTED_MARKET_GAP_DAYS,
  throughDate?: string,
) {
  return firstGapInDates(bars.filter((bar) => bar.securityId === securityId).map((bar) => bar.date), requiredFrom, maxGapDays, throughDate);
}

function firstGapInDates(securityDates: string[], requiredFrom: string, maxGapDays: number, throughDate?: string) {
  const dates = [...new Set(securityDates)].sort();
  let previous: string | null = null;
  for (const date of dates) {
    if (date < requiredFrom) {
      previous = date;
      continue;
    }
    if (previous && daysBetween(previous, date) > maxGapDays) return previous < requiredFrom ? requiredFrom : addDays(previous, 1);
    previous = date;
  }
  if (throughDate && previous && throughDate > previous && daysBetween(previous, throughDate) > maxGapDays) {
    return addDays(previous, 1);
  }
  return null;
}

export function missingHistoryRequirements(
  bars: MarketBar[],
  requirements: HistoryRequirement,
  inceptionDates: Record<string, string> = {},
  throughDate?: string,
) {
  const coverage = historyCoverage(bars);
  // One pass groups dates by security instead of one scan of every bar per requirement.
  const datesBySecurity = new Map<string, string[]>();
  for (const bar of bars) {
    if (!requirements.has(bar.securityId)) continue;
    const dates = datesBySecurity.get(bar.securityId);
    if (dates) dates.push(bar.date);
    else datesBySecurity.set(bar.securityId, [bar.date]);
  }
  return [...requirements].flatMap(([securityId, requiredFrom]) => {
    const current = coverage.get(securityId);
    return !historyRequirementSatisfied(current?.first, requiredFrom, HISTORY_START_GRACE_DAYS, inceptionDates[securityId])
      || firstGapInDates(datesBySecurity.get(securityId) ?? [], requiredFrom, MAX_EXPECTED_MARKET_GAP_DAYS, throughDate)
      ? [securityId]
      : [];
  });
}
