import Decimal from "decimal.js";
export { Decimal };

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export type LedgerTransaction = {
  id: string;
  accountId: string;
  /** Stable brokerage + account-type key supplied by the application. Falls back to accountId. */
  costBasisGroup?: string;
  securityId: string | null;
  type: "BUY" | "SELL" | "TRANSFER_IN" | "DIVIDEND" | "DEPOSIT" | "WITHDRAWAL";
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
  /** Trading venue for providers that expose more than one market. */
  venueCode?: string;
  /** Session represented by this observation. */
  session?: MarketQuote["session"];
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

export type DistributionEvent = {
  id: string;
  securityId: string;
  type: "CASH_DIVIDEND" | "FUND_DISTRIBUTION" | "CAPITAL_GAIN_DISTRIBUTION" | "RETURN_OF_CAPITAL" | "UNKNOWN";
  /** Date used to determine which historical units are entitled. */
  exDate?: string;
  recordDate?: string;
  /** Date used to recognize the income. Falls back to the entitlement date when unavailable. */
  paymentDate?: string;
  amountPerUnit: string;
  /** Number of holding units represented by amountPerUnit. Japanese mutual funds normally use 10,000. */
  distributionUnit?: string;
  currency: string;
  sourceProvider: string;
  sourceUrl?: string;
  confidence: "official" | "reported" | "estimated" | "manual";
  status?: "announced" | "paid" | "estimated";
  fetchedAt?: string;
};

export type DividendReceipt = {
  id: string;
  distributionId: string;
  securityId: string;
  accountId: string;
  entitlementDate: string;
  recognitionDate: string;
  eligibleQuantity: string;
  amountPerUnit: string;
  distributionUnit: string;
  grossAmount: string;
  currency: string;
  /** Native issuer currency/amount when grossAmount has been converted for reporting. */
  sourceCurrency?: string;
  sourceGrossAmount?: string;
  type: DistributionEvent["type"];
  sourceProvider: string;
  confidence: DistributionEvent["confidence"];
};

export type DividendSummary = {
  receipts: DividendReceipt[];
  /** Backwards-compatible scalar. Only meaningful when receipts share one currency. */
  totalIncome: string;
  totalsByCurrency: Record<string, string>;
  bySecurity: Record<string, string>;
  byAccount: Record<string, string>;
  bySecurityCurrency: Record<string, Record<string, string>>;
  byAccountCurrency: Record<string, Record<string, string>>;
};

export type TransactionPositionSnapshot = {
  transactionId: string;
  beforeQuantity: string | null;
  afterQuantity: string | null;
};

export function deriveSplitAdjustedTransactions<T extends LedgerTransaction>(
  transactions: T[],
  corporateActions: CorporateAction[] = [],
): T[] {
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
  distributionIncome: string;
  realizedGain: string;
  dayGain: string | null;
};

export type PortfolioSummary = {
  holdings: DerivedHolding[];
  securitiesValue: string;
  cashValue: string;
  totalValue: string;
  costBasis: string;
  capitalRealizedGain: string;
  distributionIncome: string;
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
  dividendAdjustedValue: string;
  cumulativeDistributionIncome: string;
  /** @deprecated Use dividendAdjustedValue. */
  totalReturnValue: string;
  investedCapital: string;
  costBasis: string;
  capitalRealizedGain: string;
  distributionIncome: string;
  realizedGain: string;
  unrealizedGain: string;
  totalGain: string;
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

const distributionEntitlementDate = (event: DistributionEvent) => (event.exDate ?? event.recordDate ?? event.paymentDate ?? "").slice(0, 10);
export const distributionRecognitionDate = (event: DistributionEvent) => (event.paymentDate ?? event.exDate ?? event.recordDate ?? "").slice(0, 10);

export function canonicalDomainSecurityId(id: string) {
  const lower = id.toLowerCase().trim();
  const withoutUsMic = lower.replace(/^sec-us-([a-z0-9.-]+)-(?:xnas|xnys|arcx|xase|bats|otcm|xams)$/i, "sec-us-$1");
  const withoutJpMic = withoutUsMic.replace(/^sec-([0-9]{4}|[0-9]{3}[a-z])-(?:xtks|tse)$/i, "sec-$1");
  const bareJp = withoutJpMic.replace(/^(?:sec-)?([0-9]{4}|[0-9]{3}[a-z])(?:\.t)?$/i, "sec-$1");
  return bareJp;
}

export function matchSecurityId(left: string, right: string) {
  if (left === right) return true;
  return canonicalDomainSecurityId(left) === canonicalDomainSecurityId(right);
}

export function domainSecurityIdVariants(id: string): string[] {
  const canonical = canonicalDomainSecurityId(id);
  const variants = new Set<string>([id, id.toLowerCase(), id.toUpperCase(), canonical]);
  const jpMatch = /^sec-([0-9]{4}|[0-9]{3}[a-z])$/i.exec(canonical);
  if (jpMatch) {
    const code = jpMatch[1].toLowerCase();
    const codeUpper = jpMatch[1].toUpperCase();
    variants.add(`sec-${code}`);
    variants.add(`sec-${codeUpper}`);
    variants.add(`sec-${code}-xtks`);
    variants.add(`sec-${codeUpper}-xtks`);
    variants.add(`sec-${code}-tse`);
    variants.add(`sec-${codeUpper}-tse`);
    variants.add(code);
    variants.add(codeUpper);
    variants.add(`${code}.t`);
    variants.add(`${codeUpper}.T`);
  } else if (/^sec-us-[a-z0-9.-]+$/i.test(canonical)) {
    const sym = canonical.replace(/^sec-us-/i, "");
    variants.add(sym);
    variants.add(sym.toUpperCase());
    for (const mic of ["xnas", "xnys", "arcx", "xase", "bats", "otcm"]) {
      variants.add(`${canonical}-${mic}`);
      variants.add(`${canonical}-${mic.toUpperCase()}`);
    }
  }
  return [...variants];
}


export function calculateDividendIncome(
  transactions: LedgerTransaction[],
  distributions: DistributionEvent[] = [],
  corporateActions: CorporateAction[] = [],
  throughDate?: string,
): DividendSummary {
  const quantities = new Map<string, Decimal>();
  const accountKey = (securityId: string, accountId: string) => `${securityId}\u0000${accountId}`;
  const securityFromKey = (key: string) => key.slice(0, key.indexOf("\u0000"));
  const receipts: DividendReceipt[] = [];
  const lastDate = throughDate?.slice(0, 10);
  const confidenceRank: Record<DistributionEvent["confidence"], number> = { estimated: 1, reported: 2, official: 3, manual: 4 };
  const normalizedDistributions = new Map<string, DistributionEvent>();
  for (const distribution of distributions) {
    const entitlementDate = distributionEntitlementDate(distribution);
    const amount = new Decimal(distribution.amountPerUnit);
    if (!entitlementDate || !amount.isFinite() || amount.lte(0)) continue;
    const key = [canonicalDomainSecurityId(distribution.securityId), distribution.type, entitlementDate, distribution.currency.toUpperCase()].join("\u0000");
    const current = normalizedDistributions.get(key);
    if (!current || confidenceRank[distribution.confidence] > confidenceRank[current.confidence]
      || (confidenceRank[distribution.confidence] === confidenceRank[current.confidence]
        && (distribution.fetchedAt ?? "") >= (current.fetchedAt ?? ""))) {
      normalizedDistributions.set(key, distribution);
    }
  }
  const events = [
    ...transactions.filter((transaction) => transaction.securityId).map((transaction) => ({
      date: transaction.tradeDate.slice(0, 10), priority: 2, id: transaction.id,
      transaction, action: null as CorporateAction | null, distribution: null as DistributionEvent | null,
    })),
    ...corporateActions.map((action) => ({
      date: action.effectiveDate.slice(0, 10), priority: 0, id: action.id,
      transaction: null as LedgerTransaction | null, action, distribution: null as DistributionEvent | null,
    })),
    ...[...normalizedDistributions.values()].flatMap((distribution) => {
      const date = distributionEntitlementDate(distribution);
      const recognitionDate = distributionRecognitionDate(distribution);
      if (!date || !recognitionDate || (lastDate && recognitionDate > lastDate)) return [];
      return [{
        date, priority: 1, id: distribution.id,
        transaction: null as LedgerTransaction | null, action: null as CorporateAction | null, distribution,
      }];
    }),
  ].sort((left, right) => left.date === right.date
    ? left.priority === right.priority ? left.id.localeCompare(right.id) : left.priority - right.priority
    : left.date.localeCompare(right.date));

  for (const event of events) {
    if (event.action) {
      const factor = new Decimal(event.action.numerator).div(event.action.denominator);
      if (!factor.isFinite() || factor.lte(0)) continue;
      for (const [key, quantity] of quantities) {
        if (matchSecurityId(securityFromKey(key), event.action.securityId)) quantities.set(key, quantity.mul(factor));
      }
      continue;
    }
    if (event.distribution) {
      const distribution = event.distribution;
      const amountPerUnit = new Decimal(distribution.amountPerUnit);
      const unit = normalizedPriceUnit(distribution.distributionUnit);
      if (!amountPerUnit.isFinite() || amountPerUnit.lte(0)) continue;
      for (const [key, quantity] of quantities) {
        const securityId = securityFromKey(key);
        if (!matchSecurityId(securityId, distribution.securityId) || quantity.lte(0)) continue;
        const accountId = key.slice(key.indexOf("\u0000") + 1);
        const grossAmount = quantity.mul(amountPerUnit).div(unit);
        receipts.push({
          id: `${distribution.id}:${securityId}:${accountId}`,
          distributionId: distribution.id,
          securityId,
          accountId,
          entitlementDate: distributionEntitlementDate(distribution),
          recognitionDate: distributionRecognitionDate(distribution),
          eligibleQuantity: quantity.toString(),
          amountPerUnit: amountPerUnit.toString(),
          distributionUnit: unit.toString(),
          grossAmount: grossAmount.toString(),
          currency: distribution.currency,
          type: distribution.type,
          sourceProvider: distribution.sourceProvider,
          confidence: distribution.confidence,
        });
      }
      continue;
    }
    const transaction = event.transaction;
    if (!transaction?.securityId) continue;
    const key = accountKey(transaction.securityId, transaction.accountId);
    const before = quantities.get(key) ?? new Decimal(0);
    const quantity = new Decimal(transaction.quantity ?? 0).abs();
    // Imported payment records are actual cash movements, not issuer events. They
    // must not stack on top of the modeled gross entitlement total.
    if (transaction.type === "DIVIDEND") continue;
    const after = transaction.type === "SELL"
      ? Decimal.max(0, before.minus(Decimal.min(before, quantity)))
      : before.plus(quantity);
    quantities.set(key, after);
  }

  receipts.sort((left, right) => left.recognitionDate === right.recognitionDate
    ? left.id.localeCompare(right.id)
    : left.recognitionDate.localeCompare(right.recognitionDate));
  return summarizeDividendReceipts(receipts);
}

export function summarizeDividendReceipts(receipts: DividendReceipt[]): DividendSummary {
  const bySecurity = new Map<string, Decimal>();
  const byAccount = new Map<string, Decimal>();
  const totalsByCurrency = new Map<string, Decimal>();
  const bySecurityCurrency = new Map<string, Map<string, Decimal>>();
  const byAccountCurrency = new Map<string, Map<string, Decimal>>();
  let totalIncome = new Decimal(0);
  for (const receipt of receipts) {
    const amount = new Decimal(receipt.grossAmount);
    if (!amount.isFinite() || amount.lte(0)) continue;
    const currency = receipt.currency.toUpperCase();
    totalIncome = totalIncome.plus(amount);
    totalsByCurrency.set(currency, (totalsByCurrency.get(currency) ?? new Decimal(0)).plus(amount));
    bySecurity.set(receipt.securityId, (bySecurity.get(receipt.securityId) ?? new Decimal(0)).plus(amount));
    byAccount.set(receipt.accountId, (byAccount.get(receipt.accountId) ?? new Decimal(0)).plus(amount));
    const securityCurrencies = bySecurityCurrency.get(receipt.securityId) ?? new Map<string, Decimal>();
    securityCurrencies.set(currency, (securityCurrencies.get(currency) ?? new Decimal(0)).plus(amount));
    bySecurityCurrency.set(receipt.securityId, securityCurrencies);
    const accountCurrencies = byAccountCurrency.get(receipt.accountId) ?? new Map<string, Decimal>();
    accountCurrencies.set(currency, (accountCurrencies.get(currency) ?? new Decimal(0)).plus(amount));
    byAccountCurrency.set(receipt.accountId, accountCurrencies);
  }
  return {
    receipts,
    totalIncome: totalIncome.toString(),
    totalsByCurrency: Object.fromEntries([...totalsByCurrency].map(([currency, amount]) => [currency, amount.toString()])),
    bySecurity: Object.fromEntries([...bySecurity].map(([secKey, amount]) => [secKey, amount.toString()])),
    byAccount: Object.fromEntries([...byAccount].map(([accKey, amount]) => [accKey, amount.toString()])),
    bySecurityCurrency: Object.fromEntries([...bySecurityCurrency].map(([securityId, currencies]) => [securityId, Object.fromEntries([...currencies].map(([currency, amount]) => [currency, amount.toString()]))])),
    byAccountCurrency: Object.fromEntries([...byAccountCurrency].map(([accountId, currencies]) => [accountId, Object.fromEntries([...currencies].map(([currency, amount]) => [currency, amount.toString()]))])),
  };
}

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
  distributions: DistributionEvent[] = [],
  throughDate?: string,
  dividendReceipts?: DividendReceipt[],
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

  const dividendSummary = dividendReceipts
    ? summarizeDividendReceipts(dividendReceipts)
    : calculateDividendIncome(transactions, distributions, corporateActions, throughDate);
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
    const security = securityMap.get(securityId) ?? [...securityMap.values()].find((s) => matchSecurityId(s.id, securityId));
    if (!security) continue;
    const priceUnit = normalizedPriceUnit(security.priceUnit);
    costBasis = costBasis.plus(state.totalCost);

    const distIncomeKey = Object.keys(dividendSummary.bySecurity).find((k) => matchSecurityId(k, securityId));
    const distIncome = distIncomeKey ? dividendSummary.bySecurity[distIncomeKey] : "0";

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
        distributionIncome: distIncome,
        realizedGain: state.realizedGain.plus(distIncome).toString(),
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
      distributionIncome: distIncome,
      realizedGain: state.realizedGain.plus(distIncome).toString(),
      dayGain: holdingDayGain.toString(),
    });
  }

  holdings.sort((a, b) => {
    if (a.marketValue == null) return 1;
    if (b.marketValue == null) return -1;
    return new Decimal(b.marketValue).cmp(a.marketValue);
  });

  const coverage = costBasis.gt(0) ? pricedCostBasis.div(costBasis).mul(100) : new Decimal(100);
  const distributionIncome = new Decimal(dividendSummary.totalIncome);
  const combinedRealizedGain = realizedGain.plus(distributionIncome);
  return {
    holdings,
    securitiesValue: securitiesValue.toString(),
    cashValue: "0",
    totalValue: securitiesValue.toString(),
    costBasis: costBasis.toString(),
    capitalRealizedGain: realizedGain.toString(),
    distributionIncome: distributionIncome.toString(),
    realizedGain: combinedRealizedGain.toString(),
    unrealizedGain: unrealizedGain.toString(),
    totalGain: unrealizedGain.plus(combinedRealizedGain).toString(),
    dayGain: dayGain.toString(),
    netDeposits: costBasis.toString(),
    pricedSecurityCount,
    unpricedSecurityCount,
    quoteCoveragePercent: coverage.toString(),
  };
}

export function indexPortfolioHistoryBars(bars: MarketBar[]): Map<string, MarketBar[]> {
  const index = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const items = index.get(bar.date) ?? [];
    items.push(bar);
    index.set(bar.date, items);
  }
  return index;
}

export function reconstructPortfolioHistory(...args: Parameters<typeof reconstructPortfolioHistorySteps>): PortfolioHistoryPoint[] {
  const steps = reconstructPortfolioHistorySteps(...args);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Pure cooperative iterator; callers choose their own scheduling environment. */
export function* reconstructPortfolioHistorySteps(
  transactions: LedgerTransaction[],
  securities: SecurityQuote[],
  bars: MarketBar[],
  corporateActions: CorporateAction[] = [],
  throughDate?: string,
  distributions: DistributionEvent[] = [],
  dividendReceiptsOverride?: DividendReceipt[],
  indexedBars?: Map<string, MarketBar[]>,
): Generator<void, PortfolioHistoryPoint[], void> {
  const barsByDate = indexedBars ?? indexPortfolioHistoryBars(bars);

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
  const dividendReceipts = [...(dividendReceiptsOverride ?? calculateDividendIncome(transactions, distributions, corporateActions, latestDate).receipts)]
    .filter((receipt) => new Decimal(receipt.grossAmount).gt(0))
    .sort((left, right) => left.recognitionDate === right.recognitionDate
      ? left.id.localeCompare(right.id)
      : left.recognitionDate.localeCompare(right.recognitionDate));
  let dividendIndex = 0;
  let cumulativeDistributionIncome = new Decimal(0);

  const securityMap = new Map(securities.map((security) => [security.id, security]));
  const states = new Map<string, HoldingState>();

  const events = [
    ...transactions.map((transaction) => ({
      date: transaction.tradeDate,
      dateKey: transaction.tradeDate.slice(0, 10),
      priority: 1,
      id: transaction.id,
      transaction,
      action: null as CorporateAction | null,
    })),
    ...corporateActions.map((action) => ({
      date: action.effectiveDate,
      dateKey: action.effectiveDate.slice(0, 10),
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

  let eventIndex = 0;

  for (const date of dates) {
    while (dividendIndex < dividendReceipts.length && dividendReceipts[dividendIndex].recognitionDate <= date) {
      cumulativeDistributionIncome = cumulativeDistributionIncome.plus(dividendReceipts[dividendIndex].grossAmount);
      dividendIndex += 1;
    }

    while (eventIndex < events.length && events[eventIndex].dateKey <= date) {
      const event = events[eventIndex];
      eventIndex += 1;
      if (event.action) {
        const factor = new Decimal(event.action.numerator).div(event.action.denominator);
        if (factor.isFinite() && factor.gt(0)) {
          for (const [key, state] of states) {
            if (stateSecurityId(key) === event.action.securityId) applyFactorToState(state, factor);
          }
        }
        continue;
      }

      const transaction = event.transaction;
      if (!transaction || !transaction.securityId) continue;
      const amount = amountFor(transaction, securityMap.get(transaction.securityId)?.priceUnit);
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

    const barsToday = new Set<string>();
    for (const bar of barsByDate.get(date) ?? []) {
      latestPrices.set(bar.securityId, bar.close);
      latestPrices.set(canonicalDomainSecurityId(bar.securityId), bar.close);
      latestPriceDates.set(bar.securityId, date);
      latestPriceDates.set(canonicalDomainSecurityId(bar.securityId), date);
      barsToday.add(bar.securityId);
      barsToday.add(canonicalDomainSecurityId(bar.securityId));
    }
    for (const transaction of transactionsByDate.get(date) ?? []) {
      if (!transaction.securityId || barsToday.has(transaction.securityId) || barsToday.has(canonicalDomainSecurityId(transaction.securityId))) continue;
      const executionPrice = Number(transaction.pricePerShare);
      const lastPriceDate = latestPriceDates.get(transaction.securityId) ?? latestPriceDates.get(canonicalDomainSecurityId(transaction.securityId));
      const staleDays = lastPriceDate ? (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${lastPriceDate}T00:00:00Z`).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
      if (Number.isFinite(executionPrice) && executionPrice > 0 && staleDays > 14) {
        latestPrices.set(transaction.securityId, String(executionPrice));
        latestPrices.set(canonicalDomainSecurityId(transaction.securityId), String(executionPrice));
        latestPriceDates.set(transaction.securityId, date);
        latestPriceDates.set(canonicalDomainSecurityId(transaction.securityId), date);
      }
    }

    let realizedGain = new Decimal(0);
    let costBasis = new Decimal(0);
    let pricedCostBasis = new Decimal(0);
    let securitiesValue = new Decimal(0);

    const aggregatedStates = new Map<string, { quantity: Decimal; totalCost: Decimal }>();
    for (const [key, state] of states) {
      realizedGain = realizedGain.plus(state.realizedGain);
      const securityId = stateSecurityId(key);
      const aggregate = aggregatedStates.get(securityId) ?? { quantity: new Decimal(0), totalCost: new Decimal(0) };
      aggregate.quantity = aggregate.quantity.plus(stateQuantity(state));
      aggregate.totalCost = aggregate.totalCost.plus(stateCost(state));
      aggregatedStates.set(securityId, aggregate);
    }

    for (const [securityId, state] of aggregatedStates) {
      if (state.quantity.lte(0)) continue;
      const security = securityMap.get(securityId) ?? [...securityMap.values()].find((s) => matchSecurityId(s.id, securityId));
      if (!security) continue;
      const priceUnit = normalizedPriceUnit(security.priceUnit);
      costBasis = costBasis.plus(state.totalCost);

      const close = latestPrices.get(security.id) ?? latestPrices.get(canonicalDomainSecurityId(security.id));
      if (close != null) {
        const currentPrice = new Decimal(close);
        const marketValue = state.quantity.mul(currentPrice).div(priceUnit);
        securitiesValue = securitiesValue.plus(marketValue);
        pricedCostBasis = pricedCostBasis.plus(state.totalCost);
      }
    }

    const unrealizedGain = securitiesValue.minus(pricedCostBasis);
    const combinedRealizedGain = realizedGain.plus(cumulativeDistributionIncome);
    const totalGain = unrealizedGain.plus(combinedRealizedGain);
    points.push({
      date,
      totalValue: securitiesValue.toString(),
      dividendAdjustedValue: securitiesValue.plus(cumulativeDistributionIncome).toString(),
      cumulativeDistributionIncome: cumulativeDistributionIncome.toString(),
      totalReturnValue: securitiesValue.plus(cumulativeDistributionIncome).toString(),
      investedCapital: costBasis.toString(),
      costBasis: costBasis.toString(),
      capitalRealizedGain: realizedGain.toString(),
      distributionIncome: cumulativeDistributionIncome.toString(),
      realizedGain: combinedRealizedGain.toString(),
      unrealizedGain: unrealizedGain.toString(),
      totalGain: totalGain.toString(),
    });
    yield;
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
