import type { CorporateAction, MarketBar } from "@kabutora/domain";

export type HistoryQuality = {
  status: "valid" | "warning";
  checkedAt: string;
  acceptedBars: number;
  rejectedBars: number;
  duplicateBars: number;
  suspectMoves: number;
  repairedBars?: number;
  acceptedActions: number;
  rejectedActions: number;
  checksum: string;
};

export type PackedHistorySeries = Record<string, { provider: string; rows: Array<[date: string, close: string, adjustedClose?: string]> }>;

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

const DAY_MS = 24 * 60 * 60 * 1000;
const SPLIT_WINDOW_MS = 4 * DAY_MS;

/**
 * UTC midnight of an ISO calendar date, or NaN when the date is malformed or does not exist.
 * Bars of every security share the same few thousand dates, so one inspection parses each once.
 */
function createDayClock() {
  const cache = new Map<string, number>();
  return (value: string) => {
    let time = cache.get(value);
    if (time === undefined) {
      time = datePattern.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
      if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) !== value) time = Number.NaN;
      cache.set(value, time);
    }
    return time;
  };
}
type DayClock = ReturnType<typeof createDayClock>;

/** Validated ISO dates order the same by code unit as by locale, without a collator call per comparison. */
const compareDates = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Bar order: date, then security ID by locale. IDs are collated once (equal IDs share a rank),
 * so the order, and with it the checksum, matches a `localeCompare` per comparison.
 */
function sortBarsByDateAndSecurity(bars: MarketBar[]) {
  const ids = [...new Set(bars.map((bar) => bar.securityId))].sort((left, right) => left.localeCompare(right));
  const rank = new Map<string, number>();
  ids.forEach((id, index) => rank.set(id, index && ids[index - 1]!.localeCompare(id) === 0 ? rank.get(ids[index - 1]!)! : index));
  return bars.sort((a, b) => compareDates(a.date, b.date) || rank.get(a.securityId)! - rank.get(b.securityId)!);
}

function checksum(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeHistoryBars(
  bars: MarketBar[],
  actionDates: Map<string, number[]>,
  day: DayClock,
): { bars: MarketBar[]; repairedCount: number } {
  if (bars.length < 2) return { bars, repairedCount: 0 };

  const bySecurity = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const list = bySecurity.get(bar.securityId) ?? [];
    list.push(bar);
    bySecurity.set(bar.securityId, list);
  }

  let repairedCount = 0;
  const result: MarketBar[] = [];

  for (const [securityId, secBars] of bySecurity) {
    const splitDates = actionDates.get(securityId);
    /** Most securities have no splits, so their bar dates are never parsed. */
    const nearSplit = (date: string) => Boolean(splitDates?.some((actionDate) => Math.abs(actionDate - day(date)) <= SPLIT_WINDOW_MS));
    const sorted = [...secBars].sort((a, b) => compareDates(a.date, b.date));
    const n = sorted.length;
    if (n < 2) {
      result.push(...sorted);
      continue;
    }

    const currentBars = sorted.map((b) => ({ ...b }));

    // Pass 1: Single-bar isolated anomalies (dips and spikes in close price)
    for (let i = 1; i < n - 1; i += 1) {
      const prev = currentBars[i - 1];
      const curr = currentBars[i];
      const next = currentBars[i + 1];

      const pPrev = Number(prev.close);
      const pCurr = Number(curr.close);
      const pNext = Number(next.close);
      if (!Number.isFinite(pPrev) || !Number.isFinite(pCurr) || !Number.isFinite(pNext) || pPrev <= 0 || pNext <= 0) continue;
      if (nearSplit(curr.date)) continue;

      const ratioPrev = pCurr / pPrev;
      const ratioNext = pCurr / pNext;
      const neighborRatio = pNext / pPrev;

      const neighborsConsistent = neighborRatio >= 0.5 && neighborRatio <= 2.0;
      const isIsolatedDip = neighborsConsistent && ratioPrev <= 0.65 && ratioNext <= 0.65;
      const isIsolatedSpike = neighborsConsistent && ratioPrev >= 1.5 && ratioNext >= 1.5;

      if (isIsolatedDip || isIsolatedSpike) {
        const tPrev = day(prev.date);
        const tCurr = day(curr.date);
        const tNext = day(next.date);
        const alpha = tNext > tPrev ? Math.max(0, Math.min(1, (tCurr - tPrev) / (tNext - tPrev))) : 0.5;
        const pRepaired = pPrev + alpha * (pNext - pPrev);
        curr.close = String(Math.round(pRepaired * 10000) / 10000);

        if (curr.adjustedClose != null) {
          const aPrev = prev.adjustedClose ? Number(prev.adjustedClose) : pPrev;
          const aNext = next.adjustedClose ? Number(next.adjustedClose) : pNext;
          const aRepaired = aPrev + alpha * (aNext - aPrev);
          curr.adjustedClose = String(Math.round(aRepaired * 10000) / 10000);
        }
        repairedCount += 1;
      }
    }

    // Pass 1b: Two-bar consecutive isolated anomalies
    for (let i = 1; i < n - 2; i += 1) {
      const prev = currentBars[i - 1];
      const curr1 = currentBars[i];
      const curr2 = currentBars[i + 1];
      const next = currentBars[i + 2];

      const pPrev = Number(prev.close);
      const pCurr1 = Number(curr1.close);
      const pCurr2 = Number(curr2.close);
      const pNext = Number(next.close);
      if (!Number.isFinite(pPrev) || !Number.isFinite(pCurr1) || !Number.isFinite(pCurr2) || !Number.isFinite(pNext) || pPrev <= 0 || pNext <= 0) continue;

      if (nearSplit(curr1.date) || nearSplit(curr2.date)) continue;

      const neighborRatio = pNext / pPrev;
      const neighborsConsistent = neighborRatio >= 0.5 && neighborRatio <= 2.0;
      const areBothDips = neighborsConsistent &&
        pCurr1 / pPrev <= 0.65 && pCurr1 / pNext <= 0.65 &&
        pCurr2 / pPrev <= 0.65 && pCurr2 / pNext <= 0.65;
      const areBothSpikes = neighborsConsistent &&
        pCurr1 / pPrev >= 1.5 && pCurr1 / pNext >= 1.5 &&
        pCurr2 / pPrev >= 1.5 && pCurr2 / pNext >= 1.5;

      if (areBothDips || areBothSpikes) {
        const tPrev = day(prev.date);
        const tCurr1 = day(curr1.date);
        const tCurr2 = day(curr2.date);
        const tNext = day(next.date);
        const span = tNext - tPrev;
        if (span > 0) {
          const alpha1 = Math.max(0, Math.min(1, (tCurr1 - tPrev) / span));
          const alpha2 = Math.max(0, Math.min(1, (tCurr2 - tPrev) / span));
          curr1.close = String(Math.round((pPrev + alpha1 * (pNext - pPrev)) * 10000) / 10000);
          curr2.close = String(Math.round((pPrev + alpha2 * (pNext - pPrev)) * 10000) / 10000);
          if (curr1.adjustedClose != null) {
            const aPrev = prev.adjustedClose ? Number(prev.adjustedClose) : pPrev;
            const aNext = next.adjustedClose ? Number(next.adjustedClose) : pNext;
            curr1.adjustedClose = String(Math.round((aPrev + alpha1 * (aNext - aPrev)) * 10000) / 10000);
            curr2.adjustedClose = String(Math.round((aPrev + alpha2 * (aNext - aPrev)) * 10000) / 10000);
          }
          repairedCount += 2;
        }
      }
    }

    // Pass 2: AdjustedClose isolated anomalies
    for (let i = 1; i < n - 1; i += 1) {
      const prev = currentBars[i - 1];
      const curr = currentBars[i];
      const next = currentBars[i + 1];
      if (curr.adjustedClose == null) continue;

      const aPrev = prev.adjustedClose ? Number(prev.adjustedClose) : Number(prev.close);
      const aCurr = Number(curr.adjustedClose);
      const aNext = next.adjustedClose ? Number(next.adjustedClose) : Number(next.close);
      if (!Number.isFinite(aPrev) || !Number.isFinite(aCurr) || !Number.isFinite(aNext) || aPrev <= 0 || aNext <= 0) continue;
      if (nearSplit(curr.date)) continue;

      const aNeighborRatio = aNext / aPrev;
      const aNeighborsConsistent = aNeighborRatio >= 0.5 && aNeighborRatio <= 2.0;
      const isAdjDip = aNeighborsConsistent && aCurr / aPrev <= 0.65 && aCurr / aNext <= 0.65;
      const isAdjSpike = aNeighborsConsistent && aCurr / aPrev >= 1.5 && aCurr / aNext >= 1.5;

      if (isAdjDip || isAdjSpike) {
        const tPrev = day(prev.date);
        const tCurr = day(curr.date);
        const tNext = day(next.date);
        const alpha = tNext > tPrev ? Math.max(0, Math.min(1, (tCurr - tPrev) / (tNext - tPrev))) : 0.5;
        const aRepaired = aPrev + alpha * (aNext - aPrev);
        curr.adjustedClose = String(Math.round(aRepaired * 10000) / 10000);
        repairedCount += 1;
      }
    }

    // Pass 3: Edge bar anomalies (tail bar and leading bar)
    if (n >= 2) {
      const last = currentBars[n - 1];
      const secondLast = currentBars[n - 2];
      const pLast = Number(last.close);
      const pSecondLast = Number(secondLast.close);

      if (Number.isFinite(pLast) && Number.isFinite(pSecondLast) && pSecondLast > 0 && !nearSplit(last.date)) {
        const tailRatio = pLast / pSecondLast;
        if (tailRatio <= 0.65 || tailRatio >= 1.50) {
          last.close = secondLast.close;
          if (last.adjustedClose != null && secondLast.adjustedClose != null) {
            last.adjustedClose = secondLast.adjustedClose;
          }
          repairedCount += 1;
        }
      }

      const first = currentBars[0];
      const second = currentBars[1];
      const pFirst = Number(first.close);
      const pSecond = Number(second.close);
      if (Number.isFinite(pFirst) && Number.isFinite(pSecond) && pFirst > 0 && !nearSplit(first.date)) {
        const leadRatio = pFirst / pSecond;
        if (leadRatio <= 0.65 || leadRatio >= 1.50) {
          first.close = second.close;
          if (first.adjustedClose != null && second.adjustedClose != null) {
            first.adjustedClose = second.adjustedClose;
          }
          repairedCount += 1;
        }
      }
    }

    result.push(...currentBars);
  }

  return {
    bars: sortBarsByDateAndSecurity(result),
    repairedCount,
  };
}

export function inspectMarketHistory(existingBars: MarketBar[], incomingBars: MarketBar[], candidateActions: CorporateAction[]) {
  const day = createDayClock();
  const validDate = (value: string) => Number.isFinite(day(value));
  const barMap = new Map<string, MarketBar>();
  let rejectedBars = 0;
  let duplicateBars = 0;
  for (const bar of [...existingBars, ...incomingBars]) {
    const close = Number(bar?.close);
    if (!bar?.securityId || !validDate(bar.date) || !Number.isFinite(close) || close <= 0 || close > 1_000_000_000_000) {
      rejectedBars += 1;
      continue;
    }
    const key = `${bar.securityId}:${bar.date}`;
    if (barMap.has(key)) duplicateBars += 1;
    const adjustedClose = Number(bar?.adjustedClose);
    const { adjustedClose: _discardedAdjustedClose, ...baseBar } = bar;
    barMap.set(key, {
      ...baseBar,
      close: String(close),
      ...(Number.isFinite(adjustedClose) && adjustedClose > 0 ? { adjustedClose: String(adjustedClose) } : {}),
    });
  }
  const rawBars = sortBarsByDateAndSecurity([...barMap.values()]);

  const actionMap = new Map<string, CorporateAction>();
  let rejectedActions = 0;
  for (const action of candidateActions) {
    const numerator = Number(action?.numerator);
    const denominator = Number(action?.denominator);
    if (!action?.id || !action.securityId || !validDate(action.effectiveDate) || !Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0 || numerator / denominator > 10_000 || denominator / numerator > 10_000) {
      rejectedActions += 1;
      continue;
    }
    actionMap.set(action.id, { ...action, numerator: String(numerator), denominator: String(denominator) });
  }
  const actions = [...actionMap.values()].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
  const actionDates = new Map<string, number[]>();
  for (const action of actions) {
    const dates = actionDates.get(action.securityId) ?? [];
    dates.push(day(action.effectiveDate));
    actionDates.set(action.securityId, dates);
  }

  const { bars, repairedCount } = sanitizeHistoryBars(rawBars, actionDates, day);

  let suspectMoves = 0;
  const previous = new Map<string, MarketBar>();
  for (const bar of bars) {
    const prior = previous.get(bar.securityId);
    if (prior) {
      const ratio = Number(bar.close) / Number(prior.close);
      const explainedBySplit = Boolean(actionDates.get(bar.securityId)?.some((actionDate) => Math.abs(actionDate - day(bar.date)) <= SPLIT_WINDOW_MS));
      if (!explainedBySplit && (ratio >= 4 || ratio <= 0.25)) suspectMoves += 1;
    }
    previous.set(bar.securityId, bar);
  }

  const digest = checksum([
    ...bars.map((bar) => `${bar.securityId}|${bar.date}|${bar.close}|${bar.adjustedClose ?? ""}`),
    ...actions.map((action) => `${action.id}|${action.securityId}|${action.effectiveDate}|${action.numerator}|${action.denominator}`),
  ].join("\n"));
  const quality: HistoryQuality = {
    status: rejectedBars || rejectedActions || suspectMoves ? "warning" : "valid",
    checkedAt: new Date().toISOString(),
    acceptedBars: bars.length,
    rejectedBars,
    duplicateBars,
    suspectMoves,
    repairedBars: repairedCount,
    acceptedActions: actions.length,
    rejectedActions,
    checksum: digest,
  };
  return { bars, actions, quality };
}

export function earliestHistoryDate(bars: MarketBar[], securityId: string) {
  return bars.find((bar) => bar.securityId === securityId)?.date ?? null;
}

export function packHistoryBars(bars: MarketBar[]): PackedHistorySeries {
  const series: PackedHistorySeries = {};
  for (const bar of bars) {
    const current = series[bar.securityId] ?? { provider: bar.provider, rows: [] };
    current.provider = current.provider && current.provider !== "quote_log" ? current.provider : (bar.provider || current.provider);
    current.rows.push(bar.adjustedClose ? [bar.date, bar.close, bar.adjustedClose] : [bar.date, bar.close]);
    series[bar.securityId] = current;
  }
  return series;
}

export function unpackHistoryBars(series: PackedHistorySeries | null | undefined): MarketBar[] {
  if (!series) return [];
  return Object.entries(series).flatMap(([securityId, value]) => value.rows.map(([date, close, adjustedClose]) => ({ securityId, date, close, ...(adjustedClose ? { adjustedClose } : {}), provider: value.provider })));
}
