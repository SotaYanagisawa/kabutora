import { Decimal, calculateAverageCostPortfolio, type CorporateAction, type IntradayBar, type LedgerTransaction, type MarketBar, type MarketQuote } from "@kabutora/domain";

export type ExternalMarketNotice = {
  id: string;
  securityId: string;
  type: "TOB" | "CORPORATE";
  occurredAt: string;
  title: string;
  summary: string;
  source: string;
  offerPrice?: string;
  currency?: string;
  expiresAt?: string;
  url?: string;
};

export type PortfolioNotification = {
  id: string;
  securityId: string;
  type: "SPLIT" | "REVERSE_SPLIT" | "LIMIT_UP" | "LIMIT_DOWN" | "PRICE_UP" | "PRICE_DOWN" | "TOB" | "CORPORATE";
  occurredAt: string;
  title: string;
  summary: string;
  source: string;
  currency?: string;
  beforeQuantity?: string;
  afterQuantity?: string;
  beforeAverageCost?: string;
  afterAverageCost?: string;
  beforeReferencePrice?: string;
  afterReferencePrice?: string;
  limitPrice?: string;
  changeRatio?: string;
  portfolioImpact?: "ADJUSTED" | "INFORMATIONAL";
  offerPrice?: string;
  expiresAt?: string;
  url?: string;
};

export const DEFAULT_PRICE_ALERT_PERCENT = 5;
export const PRICE_ALERT_THRESHOLDS = [3, 4, 5, 6, 7, 8, 10, 15, 20] as const;
export const US_PRICE_MOVE_THRESHOLD = 0.05;

type SecurityForNotice = {
  id: string;
  displaySymbol: string;
  name: string;
  exchangeMic: string;
  currency?: string;
  quote?: MarketQuote;
};

const priceLimitBands: Array<[upperExclusive: number, width: number]> = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1_000, 150], [1_500, 300], [2_000, 400], [3_000, 500],
  [5_000, 700], [7_000, 1_000], [10_000, 1_500], [15_000, 3_000], [20_000, 4_000], [30_000, 5_000],
  [50_000, 7_000], [70_000, 10_000], [100_000, 15_000], [150_000, 30_000], [200_000, 40_000],
  [300_000, 50_000], [500_000, 70_000], [700_000, 100_000], [1_000_000, 150_000], [1_500_000, 300_000],
  [2_000_000, 400_000], [3_000_000, 500_000], [5_000_000, 700_000], [7_000_000, 1_000_000],
  [10_000_000, 1_500_000], [15_000_000, 3_000_000], [20_000_000, 4_000_000], [30_000_000, 5_000_000],
  [50_000_000, 7_000_000], [Number.POSITIVE_INFINITY, 10_000_000],
];

export function tseDailyPriceLimit(previousClose: number) {
  return priceLimitBands.find(([upper]) => previousClose < upper)?.[1] ?? 10_000_000;
}

function actionHoldingBefore(
  action: CorporateAction,
  transactions: LedgerTransaction[],
  securities: SecurityForNotice[],
  actions: CorporateAction[],
) {
  const actionDate = action.effectiveDate.slice(0, 10);
  const security = securities.find((item) => item.id === action.securityId);
  if (!security) return null;
  const eligibleTransactions = transactions.filter((transaction) => transaction.tradeDate.slice(0, 10) < actionDate);
  const priorActions = actions.filter((item) => item.securityId === action.securityId && item.effectiveDate.slice(0, 10) < actionDate);
  return calculateAverageCostPortfolio(eligibleTransactions, [{ ...security, quote: undefined }], priorActions).holdings.find((holding) => holding.securityId === action.securityId) ?? null;
}

function splitNotifications(transactions: LedgerTransaction[], securities: SecurityForNotice[], actions: CorporateAction[], bars: MarketBar[]) {
  const validActions = actions.filter((action) => {
    const factor = new Decimal(action.numerator).div(action.denominator);
    return factor.isFinite() && factor.gt(0);
  });

  return validActions.flatMap((action): PortfolioNotification[] => {
    const holding = actionHoldingBefore(action, transactions, securities, actions);
    const security = securities.find((item) => item.id === action.securityId)!;
    const factor = new Decimal(action.numerator).div(action.denominator);
    const securityBars = bars.filter((bar) => bar.securityId === action.securityId).sort((a, b) => a.date.localeCompare(b.date));
    const rawBeforeBar = securityBars.filter((bar) => bar.date < action.effectiveDate.slice(0, 10)).at(-1)?.close;
    const rawAfterBar = securityBars.find((bar) => bar.date >= action.effectiveDate.slice(0, 10))?.close;

    // Cumulative multiplier for subsequent splits on or after this action to unadjust provider historical bars
    const cumulativeSubsequentFactor = validActions
      .filter((act) => act.securityId === action.securityId && act.effectiveDate.slice(0, 10) >= action.effectiveDate.slice(0, 10))
      .reduce((acc, act) => acc.mul(new Decimal(act.numerator).div(act.denominator)), new Decimal(1));

    const futureSubsequentFactor = validActions
      .filter((act) => act.securityId === action.securityId && act.effectiveDate.slice(0, 10) > action.effectiveDate.slice(0, 10))
      .reduce((acc, act) => acc.mul(new Decimal(act.numerator).div(act.denominator)), new Decimal(1));

    const beforeReference = rawBeforeBar != null ? new Decimal(rawBeforeBar).mul(cumulativeSubsequentFactor).toString() : null;
    const afterReference = rawAfterBar != null ? new Decimal(rawAfterBar).mul(futureSubsequentFactor).toString() : (rawBeforeBar != null ? new Decimal(rawBeforeBar).mul(futureSubsequentFactor).toString() : null);
    const beforeQuantity = new Decimal(holding?.quantity ?? 0);
    const beforeAverageCost = new Decimal(holding?.averageCost ?? 0);
    const reverse = action.type === "REVERSE_SPLIT" || factor.lt(1);
    return [{
      id: `notice:${action.id}`,
      securityId: action.securityId,
      type: reverse ? "REVERSE_SPLIT" : "SPLIT",
      occurredAt: action.effectiveDate,
      title: `${security.name}の${reverse ? "株式併合" : "株式分割"}`,
      summary: `比率 ${action.denominator}:${action.numerator}（保有残高・取引履歴を自動反映）`,
      source: action.sourceProvider,
      currency: security.currency ?? "JPY",
      portfolioImpact: "ADJUSTED",
      ...(beforeQuantity.gt(0) ? {
        beforeQuantity: String(beforeQuantity),
        afterQuantity: beforeQuantity.mul(factor).toString(),
        beforeAverageCost: String(beforeAverageCost),
        afterAverageCost: beforeAverageCost.div(factor).toString(),
      } : {}),
      ...(beforeReference ? { beforeReferencePrice: beforeReference } : {}),
      ...(afterReference ? { afterReferencePrice: afterReference } : {}),
    }];
  });
}

function priceNotificationId(securityId: string, type: PortfolioNotification["type"], date: string) {
  return `notice:${securityId}:${type.toLowerCase().replaceAll("_", "-")}:${date}`;
}

function actionFactorNearDate(actions: CorporateAction[], securityId: string, date: string): number {
  const targetDate = new Date(`${date}T00:00:00Z`).getTime();
  for (const action of actions) {
    if (action.securityId !== securityId) continue;
    const actionDate = new Date(`${action.effectiveDate.slice(0, 10)}T00:00:00Z`).getTime();
    if (Math.abs(actionDate - targetDate) <= 3 * 24 * 60 * 60 * 1000) {
      const num = Number(action.numerator);
      const den = Number(action.denominator);
      if (num > 0 && den > 0) return num / den;
    }
  }
  return 1;
}

function currentPriceNotifications(
  securities: SecurityForNotice[],
  intradayBars: IntradayBar[],
  actions: CorporateAction[] = [],
  priceMoveThreshold: number = US_PRICE_MOVE_THRESHOLD,
) {
  const threshold = Number.isFinite(priceMoveThreshold) && priceMoveThreshold > 0 ? priceMoveThreshold : US_PRICE_MOVE_THRESHOLD;
  return securities.flatMap((security): PortfolioNotification[] => {
    if (security.exchangeMic !== "XTKS" && !["XNAS", "XNYS", "ARCX", "XASE", "BATS", "OTCM"].includes(security.exchangeMic)) return [];
    if (!security.quote?.previousRegularClose) return [];
    const quoteDate = security.quote.marketTimestamp.slice(0, 10);
    if (actions.some((action) => action.securityId === security.id && action.effectiveDate.slice(0, 10) === quoteDate)) {
      return [];
    }
    let current = Number(security.quote.price);
    let previous = Number(security.quote.previousRegularClose);
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return [];
    const factor = actionFactorNearDate(actions, security.id, quoteDate);
    if (factor !== 1 && Math.abs(current / previous - 1) > 0.35) {
      previous = previous / factor;
    }
    const securityIntraday = intradayBars.filter((bar) => bar.securityId === security.id && bar.timestamp.slice(0, 10) === quoteDate);
    if (security.exchangeMic === "XTKS") {
      const width = tseDailyPriceLimit(previous);
      const upper = previous + width;
      const lower = Math.max(0, previous - width);
      const tolerance = Math.max(0.01, current * 0.00001);
      const upperHitBar = securityIntraday.find((bar) => Number(bar.price) >= upper - tolerance);
      const lowerHitBar = securityIntraday.find((bar) => Number(bar.price) <= lower + tolerance);
      const hitUpper = current >= upper - tolerance || Boolean(upperHitBar);
      const hitLower = current <= lower + tolerance || Boolean(lowerHitBar);
      if (hitUpper || hitLower) {
        const occurredAt = (hitUpper ? upperHitBar : lowerHitBar)?.timestamp ?? security.quote.marketTimestamp;
        const date = occurredAt.slice(0, 10);
        const type = hitUpper ? "LIMIT_UP" : "LIMIT_DOWN";
        return [{
          id: priceNotificationId(security.id, type, date),
          securityId: security.id,
          type,
          occurredAt,
          title: `${security.name}が${hitUpper ? "ストップ高" : "ストップ安"}`,
          summary: `前日終値から値幅制限${hitUpper ? "上限" : "下限"}に到達`,
          source: security.quote.provider,
          currency: security.currency ?? "JPY",
          limitPrice: String(hitUpper ? upper : lower),
        }];
      }
    }

    const upper = previous * (1 + threshold);
    const lower = previous * (1 - threshold);
    const upperHitBar = securityIntraday.find((bar) => Number(bar.price) >= upper);
    const lowerHitBar = securityIntraday.find((bar) => Number(bar.price) <= lower);
    const hitUpper = current >= upper || Boolean(upperHitBar);
    const hitLower = current <= lower || Boolean(lowerHitBar);
    if (!hitUpper && !hitLower) return [];
    const positive = hitUpper;
    const occurredAt = (positive ? upperHitBar : lowerHitBar)?.timestamp ?? security.quote.marketTimestamp;
    const date = occurredAt.slice(0, 10);
    const observedPrice = Number((positive ? upperHitBar : lowerHitBar)?.price ?? current);
    const changeRatio = observedPrice / previous - 1;
    const type = positive ? "PRICE_UP" : "PRICE_DOWN";
    return [{
      id: priceNotificationId(security.id, type, date),
      securityId: security.id,
      type,
      occurredAt,
      title: `${security.name}が${positive ? "急騰" : "急落"}`,
      summary: `前日終値から${Math.abs(changeRatio * 100).toFixed(1)}%${positive ? "上昇" : "下落"}`,
      source: security.quote.provider,
      currency: security.currency ?? (security.exchangeMic === "XTKS" ? "JPY" : "USD"),
      changeRatio: String(changeRatio),
    }];
  });
}

function historicalPriceNotifications(
  transactions: LedgerTransaction[],
  securities: SecurityForNotice[],
  bars: MarketBar[],
  actions: CorporateAction[],
  priceMoveThreshold: number = US_PRICE_MOVE_THRESHOLD,
  monitoredSecurityIds?: Set<string>,
) {
  const threshold = Number.isFinite(priceMoveThreshold) && priceMoveThreshold > 0 ? priceMoveThreshold : US_PRICE_MOVE_THRESHOLD;
  const firstTradeDates = new Map<string, string>();
  for (const transaction of transactions) {
    if (!transaction.securityId) continue;
    const date = transaction.tradeDate.slice(0, 10);
    const current = firstTradeDates.get(transaction.securityId);
    if (!current || date < current) firstTradeDates.set(transaction.securityId, date);
  }
  return securities.flatMap((security): PortfolioNotification[] => {
    if (security.exchangeMic !== "XTKS" && !["XNAS", "XNYS", "ARCX", "XASE", "BATS", "OTCM"].includes(security.exchangeMic)) return [];
    const firstTradeDate = firstTradeDates.get(security.id);
    const isMonitoredOnly = !firstTradeDate && monitoredSecurityIds?.has(security.id);
    if (!firstTradeDate && !isMonitoredOnly) return [];
    const securityBars = bars.filter((bar) => bar.securityId === security.id).sort((a, b) => a.date.localeCompare(b.date));
    return securityBars.slice(1).flatMap((bar, index): PortfolioNotification[] => {
      if (firstTradeDate && bar.date.slice(0, 10) < firstTradeDate) return [];
      if (actions.some((action) => action.securityId === security.id && action.effectiveDate.slice(0, 10) === bar.date.slice(0, 10))) return [];
      const previous = Number(security.exchangeMic === "XTKS" ? securityBars[index].close : securityBars[index].adjustedClose ?? securityBars[index].close);
      const current = Number(security.exchangeMic === "XTKS" ? bar.close : bar.adjustedClose ?? bar.close);
      if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) return [];
      const date = bar.date.slice(0, 10);
      if (security.exchangeMic === "XTKS") {
        const width = tseDailyPriceLimit(previous);
        const upper = previous + width;
        const lower = Math.max(0, previous - width);
        const tolerance = Math.max(0.01, current * 0.00001);
        const hitUpper = current >= upper - tolerance;
        const hitLower = current <= lower + tolerance;
        if (hitUpper || hitLower) {
          const type = hitUpper ? "LIMIT_UP" : "LIMIT_DOWN";
          return [{
            id: priceNotificationId(security.id, type, date), securityId: security.id, type, occurredAt: bar.date,
            title: `${security.name}が${hitUpper ? "ストップ高" : "ストップ安"}`,
            summary: `前日終値から値幅制限${hitUpper ? "上限" : "下限"}で取引終了`,
            source: bar.provider, currency: security.currency ?? "JPY", limitPrice: String(hitUpper ? upper : lower),
          }];
        }
      }
      const changeRatio = current / previous - 1;
      if (Math.abs(changeRatio) < threshold) return [];
      const positive = changeRatio > 0;
      const type = positive ? "PRICE_UP" : "PRICE_DOWN";
      return [{
        id: priceNotificationId(security.id, type, date), securityId: security.id, type, occurredAt: bar.date,
        title: `${security.name}が${positive ? "急騰" : "急落"}`,
        summary: `前日終値から${Math.abs(changeRatio * 100).toFixed(1)}%${positive ? "上昇" : "下落"}`,
        source: bar.provider, currency: security.currency ?? (security.exchangeMic === "XTKS" ? "JPY" : "USD"), changeRatio: String(changeRatio),
      }];
    });
  });
}

export function mergePortfolioNotifications(...groups: PortfolioNotification[][]) {
  return [...new Map(groups.flat().map((notice) => [notice.id, notice])).values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}

export function derivePortfolioNotifications({
  transactions,
  securities,
  actions,
  bars,
  intradayBars = [],
  externalNotices = [],
  priceMoveThreshold = US_PRICE_MOVE_THRESHOLD,
  monitoredSecurityIds,
}: {
  transactions: LedgerTransaction[];
  securities: SecurityForNotice[];
  actions: CorporateAction[];
  bars: MarketBar[];
  intradayBars?: IntradayBar[];
  externalNotices?: ExternalMarketNotice[];
  priceMoveThreshold?: number;
  monitoredSecurityIds?: Set<string>;
}) {
  const everHeld = new Set(transactions.map((transaction) => transaction.securityId).filter((value): value is string => Boolean(value)));
  const relevantSecurities = securities.filter((security) =>
    everHeld.has(security.id) || (monitoredSecurityIds ? monitoredSecurityIds.has(security.id) : false),
  );
  const relevantActions = actions.filter((action) =>
    everHeld.has(action.securityId) || (monitoredSecurityIds ? monitoredSecurityIds.has(action.securityId) : false),
  );
  const relevantNotices = externalNotices.filter((notice) =>
    everHeld.has(notice.securityId) || (monitoredSecurityIds ? monitoredSecurityIds.has(notice.securityId) : false),
  );
  const generated = [
    ...splitNotifications(transactions, relevantSecurities, relevantActions, bars),
    ...historicalPriceNotifications(transactions, relevantSecurities, bars, actions, priceMoveThreshold, monitoredSecurityIds),
    ...currentPriceNotifications(relevantSecurities, intradayBars, actions, priceMoveThreshold),
    ...relevantNotices.map((notice): PortfolioNotification => ({ ...notice })),
  ];
  return mergePortfolioNotifications(generated);
}
