import type { CorporateAction, MarketBar } from "@kabutora/domain";

export type HistoryQuality = {
  status: "valid" | "warning";
  checkedAt: string;
  acceptedBars: number;
  rejectedBars: number;
  duplicateBars: number;
  suspectMoves: number;
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
  const bars = [...barMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.securityId.localeCompare(b.securityId));

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
