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

function validDate(value: string) {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
  actions: CorporateAction[],
): { bars: MarketBar[]; repairedCount: number } {
  if (bars.length < 2) return { bars, repairedCount: 0 };

  const actionDates = new Map<string, number[]>();
  for (const action of actions) {
    const dates = actionDates.get(action.securityId) ?? [];
    dates.push(new Date(`${action.effectiveDate}T00:00:00Z`).getTime());
    actionDates.set(action.securityId, dates);
  }

  const hasSplitNear = (securityId: string, timestamp: number) => {
    const dates = actionDates.get(securityId) ?? [];
    return dates.some((actionDate) => Math.abs(actionDate - timestamp) <= 4 * 24 * 60 * 60 * 1000);
  };

  const bySecurity = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const list = bySecurity.get(bar.securityId) ?? [];
    list.push(bar);
    bySecurity.set(bar.securityId, list);
  }

  let repairedCount = 0;
  const result: MarketBar[] = [];

  for (const [securityId, secBars] of bySecurity) {
    const sorted = [...secBars].sort((a, b) => a.date.localeCompare(b.date));
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

      const tCurr = new Date(`${curr.date}T00:00:00Z`).getTime();
      if (hasSplitNear(securityId, tCurr)) continue;

      const ratioPrev = pCurr / pPrev;
      const ratioNext = pCurr / pNext;
      const neighborRatio = pNext / pPrev;

      const neighborsConsistent = neighborRatio >= 0.4 && neighborRatio <= 2.5;
      const isIsolatedDip = neighborsConsistent && ratioPrev <= 0.55 && ratioNext <= 0.55;
      const isIsolatedSpike = neighborsConsistent && ratioPrev >= 1.8 && ratioNext >= 1.8;

      if (isIsolatedDip || isIsolatedSpike) {
        const tPrev = new Date(`${prev.date}T00:00:00Z`).getTime();
        const tNext = new Date(`${next.date}T00:00:00Z`).getTime();
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

      const tCurr = new Date(`${curr.date}T00:00:00Z`).getTime();
      if (hasSplitNear(securityId, tCurr)) continue;

      const aNeighborRatio = aNext / aPrev;
      const aNeighborsConsistent = aNeighborRatio >= 0.4 && aNeighborRatio <= 2.5;
      const isAdjDip = aNeighborsConsistent && aCurr / aPrev <= 0.55 && aCurr / aNext <= 0.55;
      const isAdjSpike = aNeighborsConsistent && aCurr / aPrev >= 1.8 && aCurr / aNext >= 1.8;

      if (isAdjDip || isAdjSpike) {
        const tPrev = new Date(`${prev.date}T00:00:00Z`).getTime();
        const tNext = new Date(`${next.date}T00:00:00Z`).getTime();
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
      const tLast = new Date(`${last.date}T00:00:00Z`).getTime();

      if (Number.isFinite(pLast) && Number.isFinite(pSecondLast) && pSecondLast > 0 && !hasSplitNear(securityId, tLast)) {
        const tailRatio = pLast / pSecondLast;
        if (tailRatio <= 0.35 || tailRatio >= 3.0) {
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
      const tFirst = new Date(`${first.date}T00:00:00Z`).getTime();
      if (Number.isFinite(pFirst) && Number.isFinite(pSecond) && pFirst > 0 && !hasSplitNear(securityId, tFirst)) {
        const leadRatio = pSecond / pFirst;
        if (leadRatio >= 4.0 || leadRatio <= 0.25) {
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
    bars: result.sort((a, b) => a.date.localeCompare(b.date) || a.securityId.localeCompare(b.securityId)),
    repairedCount,
  };
}

export function inspectMarketHistory(existingBars: MarketBar[], incomingBars: MarketBar[], candidateActions: CorporateAction[]) {
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
  const rawBars = [...barMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.securityId.localeCompare(b.securityId));

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
    dates.push(new Date(`${action.effectiveDate}T00:00:00Z`).getTime());
    actionDates.set(action.securityId, dates);
  }

  const { bars, repairedCount } = sanitizeHistoryBars(rawBars, actions);

  let suspectMoves = 0;
  const previous = new Map<string, MarketBar>();
  for (const bar of bars) {
    const prior = previous.get(bar.securityId);
    if (prior) {
      const ratio = Number(bar.close) / Number(prior.close);
      const date = new Date(`${bar.date}T00:00:00Z`).getTime();
      const explainedBySplit = (actionDates.get(bar.securityId) ?? []).some((actionDate) => Math.abs(actionDate - date) <= 4 * 24 * 60 * 60 * 1000);
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
    current.provider = bar.provider || current.provider;
    current.rows.push(bar.adjustedClose ? [bar.date, bar.close, bar.adjustedClose] : [bar.date, bar.close]);
    series[bar.securityId] = current;
  }
  return series;
}

export function unpackHistoryBars(series: PackedHistorySeries | null | undefined): MarketBar[] {
  if (!series) return [];
  return Object.entries(series).flatMap(([securityId, value]) => value.rows.map(([date, close, adjustedClose]) => ({ securityId, date, close, ...(adjustedClose ? { adjustedClose } : {}), provider: value.provider })));
}
