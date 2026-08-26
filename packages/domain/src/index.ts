import Decimal from "decimal.js";

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export type LedgerTransaction = {
  id: string;
  accountId: string;
  /** Stable brokerage + account-type key supplied by the application. Falls back to accountId. */
  costBasisGroup?: string;
  securityId: string | null;
  type: "BUY" | "SELL" | "TRANSFER_IN";
  tradeDate: string;
  quantity: string | null;
  pricePerShare: string | null;
  grossAmount: string | null;
};

export type MarketQuote = {
  price: string;
  previousRegularClose?: string;
  dayOpen?: string;
  dayHigh?: string;
  dayLow?: string;
  dayVolume?: string;
  marketTimestamp: string;
  fetchedAt: string;
  freshness: "live" | "near_live" | "delayed" | "cached" | "stale" | "manual";
  provider: string;
  session: "pre_market" | "regular" | "after_hours" | "pts_day" | "pts_night" | "closed";
  priceType: "last_trade" | "official_close" | "delayed_last" | "manual";
  venueCode: string;
  validationStatus: "valid" | "suspect" | "rejected";
};

export type IntradayBar = {
  securityId: string;
  timestamp: string;
  price: string;
  provider: string;
};

export type SecurityQuote = {
  id: string;
  displaySymbol: string;
  name: string;
  exchangeMic: string;
  /** Number of holding units represented by one quoted price. Japanese mutual-fund NAVs conventionally use 10,000. */
  priceUnit?: string;
  quote?: MarketQuote;
};

export type CorporateAction = {
  id: string;
  securityId: string;
  type: "SPLIT" | "REVERSE_SPLIT";
  effectiveDate: string;
  numerator: string;
  denominator: string;
  sourceProvider: string;
};

export type TransactionPositionSnapshot = {
  transactionId: string;
  beforeQuantity: string | null;
  afterQuantity: string | null;
};

export function deriveSplitAdjustedTransactions(
  transactions: LedgerTransaction[],
  corporateActions: CorporateAction[] = [],
): LedgerTransaction[] {
  if (!corporateActions.length || !transactions.length) return transactions;

  const splitActions = corporateActions.filter((a) => {
    const factor = new Decimal(a.numerator).div(a.denominator);
    return factor.isFinite() && factor.gt(0);
  });

  if (!splitActions.length) return transactions;

  return transactions.map((transaction) => {
    if (!transaction.securityId) return transaction;
    const tradeDate = transaction.tradeDate.slice(0, 10);
    const applicable = splitActions.filter(
      (a) => a.securityId === transaction.securityId && a.effectiveDate.slice(0, 10) > tradeDate,
    );
    if (!applicable.length) return transaction;

    const cumulativeFactor = applicable.reduce(
      (acc, act) => acc.mul(new Decimal(act.numerator).div(act.denominator)),
      new Decimal(1),
    );

    if (cumulativeFactor.eq(1)) return transaction;

    const adjustedQty = transaction.quantity != null
      ? new Decimal(transaction.quantity).mul(cumulativeFactor).toString()
      : transaction.quantity;
    const adjustedPrice = transaction.pricePerShare != null
      ? new Decimal(transaction.pricePerShare).div(cumulativeFactor).toString()
      : transaction.pricePerShare;

    return {
      ...transaction,
      quantity: adjustedQty,
      pricePerShare: adjustedPrice,
    };
  });
}

export function deriveTransactionPositionSnapshots(
  transactions: LedgerTransaction[],
  corporateActions: CorporateAction[] = [],
): Map<string, TransactionPositionSnapshot> {
  const adjusted = deriveSplitAdjustedTransactions(transactions, corporateActions);
  const quantities = new Map<string, Decimal>();
  const snapshots = new Map<string, TransactionPositionSnapshot>();
  const ordered = [...adjusted].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id.localeCompare(b.id) : a.tradeDate.localeCompare(b.tradeDate),
  );

  for (const transaction of ordered) {
    if (!transaction.securityId) {
      snapshots.set(transaction.id, { transactionId: transaction.id, beforeQuantity: null, afterQuantity: null });
      continue;
    }
    const positionKey = `${transaction.securityId}\u0000${transaction.costBasisGroup?.trim() || transaction.accountId}`;
    const before = quantities.get(positionKey) ?? new Decimal(0);
    const transactionQuantity = new Decimal(transaction.quantity ?? 0).abs();
    let after = before;
    if (transaction.type === "BUY" || transaction.type === "TRANSFER_IN") after = before.plus(transactionQuantity);
    else if (transaction.type === "SELL") after = Decimal.max(0, before.minus(Decimal.min(before, transactionQuantity)));
    quantities.set(positionKey, after);
    snapshots.set(transaction.id, {
      transactionId: transaction.id,
      beforeQuantity: before.toString(),
      afterQuantity: after.toString(),
    });
  }

  return snapshots;
}

export type MarketBar = {
  securityId: string;
  date: string;
  close: string;
  adjustedClose?: string;
  provider: string;
};

export type SecurityHistoryPoint = {
  date: string;
  price: number;
  value: number;
  capital: number;
  quantity: number;
};

export type DerivedHolding = {
  securityId: string;
  quantity: string;
  totalCost: string;
  averageCost: string;
  currentPrice: string | null;
  marketValue: string | null;
  unrealizedGain: string | null;
  realizedGain: string;
  dayGain: string | null;
};

export type PortfolioSummary = {
  holdings: DerivedHolding[];
  securitiesValue: string;
  cashValue: string;
  totalValue: string;
  costBasis: string;
  realizedGain: string;
  unrealizedGain: string;
  totalGain: string;
  dayGain: string;
  netDeposits: string;
  pricedSecurityCount: number;
  unpricedSecurityCount: number;
  quoteCoveragePercent: string;
};

export type PortfolioHistoryPoint = {
  date: string;
  totalValue: string;
  investedCapital: string;
  costBasis: string;
  realizedGain: string;
  unrealizedGain: string;
};

type CostBasisLot = {
  quantity: Decimal;
  totalCost: Decimal;
};

type HoldingState = {
  lots: CostBasisLot[];
  realizedGain: Decimal;
};

const normalizedPriceUnit = (value: string | number | null | undefined) => {
  const unit = new Decimal(value ?? 1);
  return unit.isFinite() && unit.gt(0) ? unit : new Decimal(1);
};

const amountFor = (transaction: LedgerTransaction, priceUnit: string | number = 1) => {
  if (transaction.grossAmount != null) return new Decimal(transaction.grossAmount);
  return new Decimal(transaction.quantity ?? 0).mul(transaction.pricePerShare ?? 0).div(normalizedPriceUnit(priceUnit));
};

const blankState = (): HoldingState => ({
  lots: [],
  realizedGain: new Decimal(0),
});

const costBasisGroupFor = (transaction: LedgerTransaction) => transaction.costBasisGroup?.trim() || transaction.accountId;
const stateKeyFor = (securityId: string, group: string) => `${securityId}\u0000${group}`;
const stateSecurityId = (key: string) => key.slice(0, key.indexOf("\u0000"));
const stateQuantity = (state: HoldingState) => state.lots.reduce((total, lot) => total.plus(lot.quantity), new Decimal(0));
const stateCost = (state: HoldingState) => state.lots.reduce((total, lot) => total.plus(lot.totalCost), new Decimal(0));

const applyFactorToState = (state: HoldingState, factor: Decimal) => {
  for (const lot of state.lots) lot.quantity = lot.quantity.mul(factor);
};

const addLot = (state: HoldingState, quantity: Decimal, totalCost: Decimal) => {
  if (quantity.lte(0)) return;
  state.lots.push({ quantity, totalCost });
};

const consumeFifo = (state: HoldingState, requestedQuantity: Decimal) => {
  let remaining = requestedQuantity;
  let allocatedBasis = new Decimal(0);
  while (remaining.gt(0) && state.lots.length) {
    const lot = state.lots[0];
    const consumed = Decimal.min(remaining, lot.quantity);
    const consumedBasis = lot.totalCost.mul(consumed.div(lot.quantity));
    lot.quantity = lot.quantity.minus(consumed);
    lot.totalCost = Decimal.max(0, lot.totalCost.minus(consumedBasis));
    allocatedBasis = allocatedBasis.plus(consumedBasis);
    remaining = remaining.minus(consumed);
    if (lot.quantity.lte(0)) state.lots.shift();
  }
  return { consumedQuantity: requestedQuantity.minus(remaining), allocatedBasis };
};

export function calculateAverageCostPortfolio(
  transactions: LedgerTransaction[],
  securities: SecurityQuote[],
  corporateActions: CorporateAction[] = [],
): PortfolioSummary {
  const securityMap = new Map(securities.map((security) => [security.id, security]));
  const states = new Map<string, HoldingState>();

  const events = [
    ...transactions.map((transaction) => ({
      date: transaction.tradeDate,
      priority: 1,
      id: transaction.id,
      transaction,
      action: null as CorporateAction | null,
    })),
    ...corporateActions.map((action) => ({
      date: action.effectiveDate,
      priority: 0,
      id: action.id,
      transaction: null as LedgerTransaction | null,
      action,
    })),
  ].sort((a, b) =>
    a.date === b.date
      ? a.priority === b.priority
        ? a.id.localeCompare(b.id)
        : a.priority - b.priority
      : a.date.localeCompare(b.date),
  );

  for (const event of events) {
    if (event.action) {
      const factor = new Decimal(event.action.numerator).div(event.action.denominator);
      if (!factor.isFinite() || factor.lte(0)) continue;
      for (const [key, state] of states) {
        if (stateSecurityId(key) === event.action.securityId) applyFactorToState(state, factor);
      }
      continue;
    }

    const transaction = event.transaction;
    if (!transaction) continue;
    const amount = amountFor(transaction, transaction.securityId ? securityMap.get(transaction.securityId)?.priceUnit : 1);

    if (!transaction.securityId) continue;

    const quantity = new Decimal(transaction.quantity ?? 0);
    const stateKey = stateKeyFor(transaction.securityId, costBasisGroupFor(transaction));
    const state = states.get(stateKey) ?? blankState();

    if (transaction.type === "BUY" || transaction.type === "TRANSFER_IN") {
      addLot(state, quantity, amount);
    } else if (transaction.type === "SELL" && quantity.gt(0)) {
      const { consumedQuantity, allocatedBasis } = consumeFifo(state, quantity);
      const proceeds = amount.mul(consumedQuantity.div(quantity));
      state.realizedGain = state.realizedGain.plus(proceeds.minus(allocatedBasis));
    }

    states.set(stateKey, state);
  }

  const holdings: DerivedHolding[] = [];
  let securitiesValue = new Decimal(0);
  let costBasis = new Decimal(0);
  let pricedCostBasis = new Decimal(0);
  let realizedGain = new Decimal(0);
  let unrealizedGain = new Decimal(0);
  let dayGain = new Decimal(0);
  let pricedSecurityCount = 0;
  let unpricedSecurityCount = 0;

  const aggregatedStates = new Map<string, { quantity: Decimal; totalCost: Decimal; realizedGain: Decimal }>();
  for (const [key, state] of states) {
    const securityId = stateSecurityId(key);
    const aggregate = aggregatedStates.get(securityId) ?? { quantity: new Decimal(0), totalCost: new Decimal(0), realizedGain: new Decimal(0) };
    aggregate.quantity = aggregate.quantity.plus(stateQuantity(state));
    aggregate.totalCost = aggregate.totalCost.plus(stateCost(state));
    aggregate.realizedGain = aggregate.realizedGain.plus(state.realizedGain);
    aggregatedStates.set(securityId, aggregate);
  }

  for (const [securityId, state] of aggregatedStates) {
    realizedGain = realizedGain.plus(state.realizedGain);
    if (state.quantity.lte(0)) continue;
    const security = securityMap.get(securityId);
    if (!security) continue;
    const priceUnit = normalizedPriceUnit(security.priceUnit);
    costBasis = costBasis.plus(state.totalCost);

    if (!security.quote || security.quote.validationStatus === "rejected") {
      unpricedSecurityCount += 1;
      holdings.push({
        securityId,
        quantity: state.quantity.toString(),
        totalCost: state.totalCost.toString(),
        averageCost: state.totalCost.div(state.quantity).mul(priceUnit).toString(),
        currentPrice: null,
        marketValue: null,
        unrealizedGain: null,
        realizedGain: state.realizedGain.toString(),
        dayGain: null,
      });
      continue;
    }

    const currentPrice = new Decimal(security.quote.price);
    const previousClose = new Decimal(security.quote.previousRegularClose ?? security.quote.price);
    const marketValue = state.quantity.mul(currentPrice).div(priceUnit);
    const holdingUnrealized = marketValue.minus(state.totalCost);
    const holdingDayGain = state.quantity.mul(currentPrice.minus(previousClose)).div(priceUnit);
    securitiesValue = securitiesValue.plus(marketValue);
    pricedCostBasis = pricedCostBasis.plus(state.totalCost);
    unrealizedGain = unrealizedGain.plus(holdingUnrealized);
    dayGain = dayGain.plus(holdingDayGain);
    pricedSecurityCount += 1;
    holdings.push({
      securityId,
      quantity: state.quantity.toString(),
      totalCost: state.totalCost.toString(),
      averageCost: state.totalCost.div(state.quantity).mul(priceUnit).toString(),
      currentPrice: currentPrice.toString(),
      marketValue: marketValue.toString(),
      unrealizedGain: holdingUnrealized.toString(),
      realizedGain: state.realizedGain.toString(),
      dayGain: holdingDayGain.toString(),
    });
  }

  holdings.sort((a, b) => {
    if (a.marketValue == null) return 1;
    if (b.marketValue == null) return -1;
    return new Decimal(b.marketValue).cmp(a.marketValue);
  });

  const coverage = costBasis.gt(0) ? pricedCostBasis.div(costBasis).mul(100) : new Decimal(100);
  return {
    holdings,
    securitiesValue: securitiesValue.toString(),
    cashValue: "0",
    totalValue: securitiesValue.toString(),
    costBasis: costBasis.toString(),
    realizedGain: realizedGain.toString(),
    unrealizedGain: unrealizedGain.toString(),
    totalGain: unrealizedGain.plus(realizedGain).toString(),
    dayGain: dayGain.toString(),
    netDeposits: costBasis.toString(),
    pricedSecurityCount,
    unpricedSecurityCount,
    quoteCoveragePercent: coverage.toString(),
  };
}

export function reconstructPortfolioHistory(
  transactions: LedgerTransaction[],
  securities: SecurityQuote[],
  bars: MarketBar[],
  corporateActions: CorporateAction[] = [],
  throughDate?: string,
): PortfolioHistoryPoint[] {
  const barsByDate = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const items = barsByDate.get(bar.date) ?? [];
    items.push(bar);
    barsByDate.set(bar.date, items);
  }

  const earliestTrade = transactions.map((item) => item.tradeDate.slice(0, 10)).sort()[0];
  if (!earliestTrade) return [];
  const latestDate = [throughDate, ...barsByDate.keys(), ...transactions.map((item) => item.tradeDate.slice(0, 10))].filter((value): value is string => Boolean(value)).sort().at(-1);
  if (!latestDate || latestDate < earliestTrade) return [];
  const dates: string[] = [];
  for (const cursor = new Date(`${earliestTrade}T00:00:00Z`), end = new Date(`${latestDate}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  const transactionsByDate = new Map<string, LedgerTransaction[]>();
  for (const transaction of transactions) {
    const date = transaction.tradeDate.slice(0, 10);
    const items = transactionsByDate.get(date) ?? [];
    items.push(transaction);
    transactionsByDate.set(date, items);
  }
  const latestPrices = new Map<string, string>();
  const latestPriceDates = new Map<string, string>();
  const points: PortfolioHistoryPoint[] = [];

  for (const date of dates) {
    const barsToday = new Set<string>();
    for (const bar of barsByDate.get(date) ?? []) {
      latestPrices.set(bar.securityId, bar.close);
      latestPriceDates.set(bar.securityId, date);
      barsToday.add(bar.securityId);
    }
    for (const transaction of transactionsByDate.get(date) ?? []) {
      if (!transaction.securityId || barsToday.has(transaction.securityId)) continue;
      const executionPrice = Number(transaction.pricePerShare);
      const lastPriceDate = latestPriceDates.get(transaction.securityId);
      const staleDays = lastPriceDate ? (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${lastPriceDate}T00:00:00Z`).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
      if (Number.isFinite(executionPrice) && executionPrice > 0 && staleDays > 14) {
        latestPrices.set(transaction.securityId, String(executionPrice));
        latestPriceDates.set(transaction.securityId, date);
      }
    }

    const historicalSecurities = securities.map((security) => {
      const close = latestPrices.get(security.id);
      return close
        ? {
            ...security,
            quote: {
              price: close,
              previousRegularClose: close,
              marketTimestamp: `${date}T06:30:00.000Z`,
              fetchedAt: `${date}T06:30:00.000Z`,
              freshness: "cached" as const,
              provider: "remote_market_history",
              session: "closed" as const,
              priceType: "official_close" as const,
              venueCode: "TSE",
              validationStatus: "valid" as const,
            },
          }
        : { ...security, quote: undefined };
    });
    const visibleTransactions = transactions.filter((item) => item.tradeDate.slice(0, 10) <= date);
    const visibleActions = corporateActions.filter((item) => item.effectiveDate.slice(0, 10) <= date);
    const summary = calculateAverageCostPortfolio(visibleTransactions, historicalSecurities, visibleActions);
    points.push({
      date,
      totalValue: summary.totalValue,
      investedCapital: summary.netDeposits,
      costBasis: summary.costBasis,
      realizedGain: summary.realizedGain,
      unrealizedGain: summary.unrealizedGain,
    });
  }

  return points;
}

export function reconstructSecurityHistory(
  securityId: string,
  bars: MarketBar[],
  transactions: LedgerTransaction[],
  corporateActions: CorporateAction[] = [],
  priceUnit: string | number = 1,
): SecurityHistoryPoint[] {
  const events = [
    ...transactions
      .filter((transaction) => transaction.securityId === securityId)
      .map((transaction) => ({
        date: transaction.tradeDate.slice(0, 10),
        priority: 1,
        id: transaction.id,
        transaction,
        action: null as CorporateAction | null,
      })),
    ...corporateActions
      .filter((action) => action.securityId === securityId)
      .map((action) => ({
        date: action.effectiveDate.slice(0, 10),
        priority: 0,
        id: action.id,
        transaction: null as LedgerTransaction | null,
        action,
      })),
  ].sort((a, b) =>
    a.date === b.date
      ? a.priority === b.priority
        ? a.id.localeCompare(b.id)
        : a.priority - b.priority
      : a.date.localeCompare(b.date),
  );
  const securityBars = bars
    .filter((bar) => bar.securityId === securityId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const firstTradeDate = events.find((event) => event.transaction)?.date;
  const states = new Map<string, HoldingState>();
  let eventIndex = 0;
  const points: SecurityHistoryPoint[] = [];

  for (const bar of securityBars) {
    while (eventIndex < events.length && events[eventIndex].date <= bar.date) {
      const event = events[eventIndex++];
      if (event.action) {
        const factor = new Decimal(event.action.numerator).div(event.action.denominator);
        if (factor.isFinite() && factor.gt(0)) {
          for (const state of states.values()) applyFactorToState(state, factor);
        }
        continue;
      }
      const transaction = event.transaction;
      if (!transaction) continue;
      const transactionQuantity = new Decimal(transaction.quantity ?? 0);
      const amount = amountFor(transaction, priceUnit);
      const group = costBasisGroupFor(transaction);
      const state = states.get(group) ?? blankState();
      if (transaction.type === "BUY" || transaction.type === "TRANSFER_IN") {
        addLot(state, transactionQuantity, amount);
      } else if (transaction.type === "SELL" && transactionQuantity.gt(0)) {
        consumeFifo(state, transactionQuantity);
      }
      states.set(group, state);
    }

    if (firstTradeDate && bar.date < firstTradeDate) continue;
    const quantity = [...states.values()].reduce((total, state) => total.plus(stateQuantity(state)), new Decimal(0));
    const cost = [...states.values()].reduce((total, state) => total.plus(stateCost(state)), new Decimal(0));
    const price = new Decimal(bar.close);
    points.push({
      date: bar.date,
      price: price.toNumber(),
      value: quantity.mul(price).div(normalizedPriceUnit(priceUnit)).toNumber(),
      capital: cost.toNumber(),
      quantity: quantity.toNumber(),
    });
  }
  return points;
}

export function applySplit(
  quantity: string,
  unitCost: string,
  numerator: string,
  denominator: string,
) {
  const factor = new Decimal(numerator).div(denominator);
  return {
    quantity: new Decimal(quantity).mul(factor).toString(),
    unitCost: new Decimal(unitCost).div(factor).toString(),
  };
}
