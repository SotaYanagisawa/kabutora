import type { MarketBar } from "@kabutora/domain";

// Keep each invocation comfortably below Workers Free's 50 external-subrequest
// limit. Redirects and optional company-name lookups also count, so a batch of
// 16 could cross the limit even though the primary provider plan fit on paper.
export const MARKET_REQUEST_BATCH_SIZE = 8;
export const HISTORY_START_GRACE_DAYS = 7;
export const MAX_EXPECTED_MARKET_GAP_DAYS = 14;

export type HistoryRequirement = Map<string, string>;

export type HistoryFetchBatch = {
  securityIds: string[];
  from: string;
  forceRefresh?: boolean;
};

function subtractDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

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

export function splitSecurityIds(value: string, batchSize = MARKET_REQUEST_BATCH_SIZE) {
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
  const dates = [...new Set(bars.filter((bar) => bar.securityId === securityId).map((bar) => bar.date))].sort();
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
  return [...requirements].flatMap(([securityId, requiredFrom]) => {
    const current = coverage.get(securityId);
    return !historyRequirementSatisfied(current?.first, requiredFrom, HISTORY_START_GRACE_DAYS, inceptionDates[securityId])
      || firstInternalHistoryGap(bars, securityId, requiredFrom, MAX_EXPECTED_MARKET_GAP_DAYS, throughDate)
      ? [securityId]
      : [];
  });
}

export function buildHistoryFetchPlan(
  securityIds: string,
  requirements: HistoryRequirement,
  bars: MarketBar[],
  batchSize = MARKET_REQUEST_BATCH_SIZE,
  inceptionDates: Record<string, string> = {},
  throughDate?: string,
): HistoryFetchBatch[] {
  const coverage = historyCoverage(bars);
  const defaultFiveYearsAgo = subtractDays(new Date().toISOString().slice(0, 10), 365 * 5 + 30);
  const requests = splitSecurityIds(securityIds, Number.MAX_SAFE_INTEGER).flat().map((securityId) => {
      const required = requirements.get(securityId) ?? defaultFiveYearsAgo;
      const current = coverage.get(securityId);
      const internalGap = firstInternalHistoryGap(bars, securityId, required, MAX_EXPECTED_MARKET_GAP_DAYS, throughDate);
      const isMissing = !historyRequirementSatisfied(current?.first, required, HISTORY_START_GRACE_DAYS, inceptionDates[securityId]);
      const isTailStale = Boolean(current?.last && throughDate && throughDate > current.last && daysBetween(current.last, throughDate) > 4);
      return {
        securityId,
        from: isMissing ? required : internalGap ?? subtractDays(current!.last, 7),
        forceRefresh: Boolean(internalGap || isTailStale),
      };
    }).sort((a, b) => Number(b.forceRefresh) - Number(a.forceRefresh) || a.from.localeCompare(b.from) || a.securityId.localeCompare(b.securityId));

  const batches: HistoryFetchBatch[] = [];
  for (const forceRefresh of [true, false]) {
    const matching = requests.filter((request) => request.forceRefresh === forceRefresh);
    for (let index = 0; index < matching.length; index += batchSize) {
      const group = matching.slice(index, index + batchSize);
      batches.push({ securityIds: group.map((request) => request.securityId), from: group[0].from, ...(forceRefresh ? { forceRefresh: true } : {}) });
    }
  }
  return batches;
}
