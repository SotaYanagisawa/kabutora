import { addDays, dateInZone, dateKey, lastIndexAtOrBefore } from "./dates";
import { marketKey, splitFactorAfter, type DailyHistory, type IntradaySeries, type Quote } from "./market";

/**
 * Portfolio engine.
 *
 * 1. `buildBook` turns ledger rows into trades whose quantities are expressed in today's share units:
 *    quantity × (product of split ratios after the trade date). The split list comes from the same
 *    `DailyHistory` as the split-adjusted closes, so prices and quantities always share one unit.
 *    A split is therefore a per-trade multiplier, not a timeline event, and cannot be applied twice.
 * 2. Positions use the moving-average cost method (移動平均法) per security and cost-basis group.
 * 3. Money is converted with USD/JPY on the trade date for cost and on the valuation date for value.
 *
 * Plain float64 throughout; values are rounded only for display. Quantities below 1e-9 are zero.
 */

export type Currency = "JPY" | "USD";
export type Target = Currency | "NATIVE";

export type LedgerTransaction = {
  id: string;
  accountId: string;
  securityId: string | null;
  type: string;
  tradeDate: string;
  quantity: string | number | null;
  pricePerShare: string | number | null;
  grossAmount: string | number | null;
  tradeCurrency?: string;
  createdAt?: string;
};

export type LedgerSecurity = {
  id: string;
  currency?: string;
  /** Units one quoted price covers; Japanese funds quote NAV per 10,000 units. */
  priceUnit?: string | number;
};

export type MarketData = {
  quotes: ReadonlyMap<string, Quote>;
  history: ReadonlyMap<string, DailyHistory>;
  intraday?: ReadonlyMap<string, IntradaySeries>;
};

/** USD/JPY: live rate, previous close, and daily closes. */
export type Fx = {
  now: number | null;
  previous: number | null;
  dates: readonly string[];
  closes: readonly number[];
  intraday?: IntradaySeries;
};

export type Trade<T extends LedgerTransaction = LedgerTransaction> = {
  transaction: T;
  id: string;
  securityId: string;
  key: string;
  accountId: string;
  group: string;
  date: string;
  /** +1 adds shares (BUY, TRANSFER_IN); -1 removes them (SELL). */
  side: 1 | -1;
  /** Today's share units. */
  quantity: number;
  /** As entered. */
  rawQuantity: number;
  splitFactor: number;
  /** Cash amount in `currency`, always positive. */
  amount: number;
  currency: string;
  nativeCurrency: string;
  unit: number;
};

export type BookIssue = { transactionId: string; reason: "invalid_quantity" | "invalid_amount" | "oversold" };

export type Book<T extends LedgerTransaction = LedgerTransaction> = {
  trades: Trade<T>[];
  bySecurity: Map<string, Trade<T>[]>;
  securities: ReadonlyMap<string, LedgerSecurity>;
  market: MarketData;
  issues: BookIssue[];
};

const EPSILON = 1e-9;
const POSITION_TYPES = new Set(["BUY", "SELL", "TRANSFER_IN"]);

export const priceUnitOf = (security: LedgerSecurity | undefined) => {
  const unit = Number(security?.priceUnit ?? 1);
  return Number.isFinite(unit) && unit > 0 ? unit : 1;
};

export const nativeCurrencyOf = (security: LedgerSecurity | undefined, securityId: string) =>
  security?.currency ?? (/^sec-us-/iu.test(securityId) ? "USD" : "JPY");

const number = (value: string | number | null | undefined) => (value == null || value === "" ? Number.NaN : Number(value));

export function buildBook<T extends LedgerTransaction>(
  transactions: readonly T[],
  securities: ReadonlyMap<string, LedgerSecurity>,
  market: MarketData,
  groupOf: (transaction: T) => string = (transaction) => transaction.accountId,
): Book<T> {
  const issues: BookIssue[] = [];
  const trades: Trade<T>[] = [];
  transactions.forEach((transaction) => {
    if (!transaction.securityId || !POSITION_TYPES.has(transaction.type)) return;
    const security = securities.get(transaction.securityId);
    const rawQuantity = Math.abs(number(transaction.quantity));
    if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
      issues.push({ transactionId: transaction.id, reason: "invalid_quantity" });
      return;
    }
    const unit = priceUnitOf(security);
    const gross = number(transaction.grossAmount);
    const amount = Number.isFinite(gross) ? Math.abs(gross) : rawQuantity * Math.abs(number(transaction.pricePerShare)) / unit;
    if (!Number.isFinite(amount)) {
      issues.push({ transactionId: transaction.id, reason: "invalid_amount" });
      return;
    }
    const key = marketKey(transaction.securityId);
    const date = dateKey(transaction.tradeDate);
    const splitFactor = splitFactorAfter(market.history.get(key)?.splits ?? [], date);
    const nativeCurrency = nativeCurrencyOf(security, transaction.securityId);
    trades.push({
      transaction,
      id: transaction.id,
      securityId: transaction.securityId,
      key,
      accountId: transaction.accountId,
      group: groupOf(transaction) || transaction.accountId,
      date,
      side: transaction.type === "SELL" ? -1 : 1,
      quantity: rawQuantity * splitFactor,
      rawQuantity,
      splitFactor,
      amount,
      currency: transaction.tradeCurrency || nativeCurrency,
      nativeCurrency,
      unit,
    });
  });
  trades.sort((left, right) => compare(left.date, right.date)
    || compare(left.transaction.tradeDate, right.transaction.tradeDate)
    || compare(left.transaction.createdAt ?? "", right.transaction.createdAt ?? "")
    || compare(left.id, right.id));
  const bySecurity = new Map<string, Trade<T>[]>();
  for (const trade of trades) {
    const list = bySecurity.get(trade.securityId);
    if (list) list.push(trade);
    else bySecurity.set(trade.securityId, [trade]);
  }
  // Oversold rows are clamped by the position logic; report them once here.
  const held = new Map<string, number>();
  for (const trade of trades) {
    const positionKey = `${trade.securityId}\u0000${trade.group}`;
    const before = held.get(positionKey) ?? 0;
    if (trade.side < 0 && trade.quantity > before + EPSILON) issues.push({ transactionId: trade.id, reason: "oversold" });
    held.set(positionKey, Math.max(0, before + trade.side * trade.quantity));
  }
  return { trades, bySecurity, securities, market, issues };
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// ---- Currency ------------------------------------------------------------------------------------

export function fxRateOn(fx: Fx, date: string): number | null {
  if (!fx.dates.length) return fx.now;
  const index = lastIndexAtOrBefore(fx.dates, date);
  return fx.closes[Math.max(0, index)] ?? fx.now;
}

/** Converts between JPY and USD with a USD/JPY rate; other pairs are unsupported (null). */
export function convert(amount: number, from: string, to: string, usdJpy: number | null): number | null {
  if (from === to) return amount;
  if (!usdJpy || !Number.isFinite(usdJpy) || usdJpy <= 0) return null;
  if (from === "USD" && to === "JPY") return amount * usdJpy;
  if (from === "JPY" && to === "USD") return amount / usdJpy;
  return null;
}

const targetCurrency = (target: Target, nativeCurrency: string) => (target === "NATIVE" ? nativeCurrency : target);

// ---- Positions ---------------------------------------------------------------------------------

type PositionState = { quantity: number; cost: number; realized: number };

/** Applies one trade with the moving-average method. Returns the realized gain of a sale. */
function applyTrade(state: PositionState, side: 1 | -1, quantity: number, amount: number) {
  if (side > 0) {
    state.quantity += quantity;
    state.cost += amount;
    return 0;
  }
  if (state.quantity <= EPSILON) return 0;
  const sold = Math.min(quantity, state.quantity);
  const allocated = state.cost * (sold / state.quantity);
  const realized = amount * (sold / quantity) - allocated;
  state.quantity -= sold;
  state.cost -= allocated;
  state.realized += realized;
  if (state.quantity <= EPSILON) {
    state.quantity = 0;
    state.cost = 0;
  }
  return realized;
}

export type Holding = {
  securityId: string;
  key: string;
  /** Currency of every money field on this holding. */
  currency: string;
  quantity: number;
  costBasis: number;
  /** Per quoted price unit (per share; per 10,000 units for Japanese funds). */
  averageCost: number;
  price: number | null;
  previousClose: number | null;
  marketValue: number | null;
  unrealizedGain: number | null;
  realizedGain: number;
  dividendIncome: number;
  dayGain: number | null;
  /** Price change of one unit since the previous close. */
  dayChangeRatio: number | null;
  /** Any trade of this security was converted by a split. */
  splitAdjusted: boolean;
  quote?: Quote;
};

export type ClosedPosition = { securityId: string; realizedGain: number; dividendIncome: number };

export type Summary = {
  currency: string;
  totalValue: number;
  costBasis: number;
  unrealizedGain: number;
  /** Capital gains realized by sales. */
  realizedGain: number;
  dividendIncome: number;
  totalGain: number;
  totalReturn: number | null;
  dayGain: number;
  dayReturn: number | null;
  pricedCount: number;
  unpricedCount: number;
  /** Some amounts could not be converted because USD/JPY is unavailable. */
  fxMissing: boolean;
};

export type Valuation = {
  summary: Summary;
  holdings: Holding[];
  closed: ClosedPosition[];
  receipts: DividendReceipt[];
};

export type ValuationOptions<T extends LedgerTransaction> = {
  target: Target;
  fx: Fx;
  /** YYYY-MM-DD (Tokyo). Dividends with a later recognition date are excluded. */
  today: string;
  include?: (trade: Trade<T>) => boolean;
};

const zoneOf = (quote: Quote) => (quote.venue === "US" || quote.currency === "USD" ? "America/New_York" : "Asia/Tokyo");

/** Session date of a quote in its exchange's time zone. PTS night trades after midnight belong to the previous date. */
export function quoteSessionDate(quote: Quote): string {
  const date = dateInZone(quote.time * 1000, zoneOf(quote));
  if (quote.session === "pts_night" && new Date(quote.time * 1000 + 9 * 3_600_000).getUTCHours() < 8) return addDays(date, -1);
  return date;
}

/** Close of the session before `sessionDate`: the daily history when it covers that date, else the quote. */
export function previousCloseFor(quote: Quote, history: DailyHistory | undefined, sessionDate: string): number | null {
  if (history?.dates.length) {
    const index = lastIndexAtOrBefore(history.dates, addDays(sessionDate, -1));
    if (index >= 0 && history.dates[index] >= addDays(sessionDate, -7)) return history.closes[index];
  }
  if (quote.previousClose == null) return null;
  // A split effective in this session: the quote's previous close may still be in old units.
  const split = history?.splits.find((item) => item.date === sessionDate);
  if (split && Math.abs(Math.log((quote.previousClose / quote.price) / split.ratio)) < Math.abs(Math.log(quote.previousClose / quote.price))) {
    return quote.previousClose / split.ratio;
  }
  return quote.previousClose;
}

export function valuePortfolio<T extends LedgerTransaction>(book: Book<T>, options: ValuationOptions<T>): Valuation {
  const { target, fx, today } = options;
  const include = options.include ?? (() => true);
  const receipts = dividendReceipts(book, options);
  const dividendBySecurity = new Map<string, number>();
  let fxMissing = receipts.some((receipt) => receipt.amount == null);
  for (const receipt of receipts) {
    if (receipt.amount != null) dividendBySecurity.set(receipt.securityId, (dividendBySecurity.get(receipt.securityId) ?? 0) + receipt.amount);
  }

  const holdings: Holding[] = [];
  const closed: ClosedPosition[] = [];
  const summary: Summary = {
    currency: target === "NATIVE" ? "" : target,
    totalValue: 0, costBasis: 0, unrealizedGain: 0, realizedGain: 0, dividendIncome: 0, totalGain: 0,
    totalReturn: null, dayGain: 0, dayReturn: null, pricedCount: 0, unpricedCount: 0, fxMissing: false,
  };
  for (const [securityId, allTrades] of book.bySecurity) {
    const trades = allTrades.filter(include);
    if (!trades.length) continue;
    const security = book.securities.get(securityId);
    const native = nativeCurrencyOf(security, securityId);
    const currency = targetCurrency(target, native);
    const unit = priceUnitOf(security);
    const quote = book.market.quotes.get(trades[0].key);
    const history = book.market.history.get(trades[0].key);
    const sessionDate = quote ? quoteSessionDate(quote) : today;

    const groups = new Map<string, PositionState>();
    const before = new Map<string, PositionState>();
    let convertible = true;
    let flowsToday = 0;
    for (const trade of trades) {
      const amount = convert(trade.amount, trade.currency, currency, fxRateOn(fx, trade.date));
      if (amount == null) { convertible = false; continue; }
      let state = groups.get(trade.group);
      if (!state) groups.set(trade.group, state = { quantity: 0, cost: 0, realized: 0 });
      const heldBefore = state.quantity;
      applyTrade(state, trade.side, trade.quantity, amount);
      if (trade.date < sessionDate) {
        let prior = before.get(trade.group);
        if (!prior) before.set(trade.group, prior = { quantity: 0, cost: 0, realized: 0 });
        applyTrade(prior, trade.side, trade.quantity, amount);
      } else if (trade.side > 0) {
        flowsToday += amount;
      } else if (trade.quantity > 0) {
        flowsToday -= amount * Math.min(1, heldBefore / trade.quantity);
      }
    }
    if (!convertible) fxMissing = true;
    let quantity = 0;
    let cost = 0;
    let realized = 0;
    for (const state of groups.values()) {
      quantity += state.quantity;
      cost += state.cost;
      realized += state.realized;
    }
    const dividendIncome = dividendBySecurity.get(securityId) ?? 0;
    summary.realizedGain += realized;
    summary.dividendIncome += dividendIncome;
    if (quantity <= EPSILON) {
      closed.push({ securityId, realizedGain: realized, dividendIncome });
      continue;
    }
    const quantityBefore = [...before.values()].reduce((total, state) => total + state.quantity, 0);
    const price = quote ? convert(quote.price, quote.currency, currency, fx.now) : null;
    const previousNative = quote ? previousCloseFor(quote, history, sessionDate) : null;
    const previousClose = quote && previousNative != null ? convert(previousNative, quote.currency, currency, fx.previous ?? fx.now) : null;
    const marketValue = price == null ? null : (quantity * price) / unit;
    const dayGain = marketValue != null && previousClose != null ? marketValue - (quantityBefore * previousClose) / unit - flowsToday : null;
    holdings.push({
      securityId,
      key: trades[0].key,
      currency,
      quantity,
      costBasis: cost,
      averageCost: (cost / quantity) * unit,
      price,
      previousClose,
      marketValue,
      unrealizedGain: marketValue == null ? null : marketValue - cost,
      realizedGain: realized,
      dividendIncome,
      dayGain,
      dayChangeRatio: quote && previousNative ? quote.price / previousNative - 1 : null,
      splitAdjusted: trades.some((trade) => trade.splitFactor !== 1),
      ...(quote ? { quote } : {}),
    });
    summary.costBasis += cost;
    if (marketValue == null) {
      summary.unpricedCount += 1;
      continue;
    }
    summary.pricedCount += 1;
    summary.totalValue += marketValue;
    summary.unrealizedGain += marketValue - cost;
    summary.dayGain += dayGain ?? 0;
  }
  holdings.sort((left, right) => (right.marketValue ?? -1) - (left.marketValue ?? -1));
  summary.fxMissing = fxMissing;
  summary.totalGain = summary.unrealizedGain + summary.realizedGain + summary.dividendIncome;
  summary.totalReturn = summary.costBasis > 0 ? summary.totalGain / summary.costBasis : null;
  const previousValue = summary.totalValue - summary.dayGain;
  summary.dayReturn = previousValue > 0 ? summary.dayGain / previousValue : null;
  return { summary, holdings, closed, receipts };
}

// ---- Dividends ---------------------------------------------------------------------------------

export type DividendReceipt = {
  id: string;
  securityId: string;
  accountId: string;
  exDate: string;
  payDate?: string;
  recognitionDate: string;
  /** Eligible units, today's share units. */
  quantity: number;
  /** Per unit (per `unit` units for Japanese funds), native currency, today's share units. */
  amountPerUnit: number;
  unit: number;
  nativeCurrency: string;
  nativeAmount: number;
  /** Converted with USD/JPY on the recognition date; null when unavailable. */
  amount: number | null;
  currency: string;
};

/** Units held per account at the end of the day before each ex-date, times the per-unit amount. */
export function dividendReceipts<T extends LedgerTransaction>(book: Book<T>, options: Pick<ValuationOptions<T>, "target" | "fx" | "today" | "include">): DividendReceipt[] {
  const include = options.include ?? (() => true);
  const receipts: DividendReceipt[] = [];
  for (const [securityId, allTrades] of book.bySecurity) {
    const trades = allTrades.filter(include);
    const dividends = [...book.market.history.get(trades[0]?.key ?? "")?.dividends ?? []].sort((left, right) => compare(left.date, right.date));
    if (!trades.length || !dividends.length) continue;
    const security = book.securities.get(securityId);
    const native = nativeCurrencyOf(security, securityId);
    const currency = targetCurrency(options.target, native);
    const unit = priceUnitOf(security);
    const held = new Map<string, number>();
    let index = 0;
    for (const dividend of dividends) {
      while (index < trades.length && trades[index].date < dividend.date) {
        const trade = trades[index++];
        const current = held.get(trade.accountId) ?? 0;
        held.set(trade.accountId, Math.max(0, current + trade.side * trade.quantity));
      }
      const recognitionDate = dividend.payDate ?? dividend.date;
      if (recognitionDate > options.today || !(dividend.amount > 0)) continue;
      for (const [accountId, quantity] of held) {
        if (quantity <= EPSILON) continue;
        const nativeAmount = (quantity * dividend.amount) / unit;
        receipts.push({
          id: `${securityId}:${dividend.date}:${accountId}`,
          securityId,
          accountId,
          exDate: dividend.date,
          ...(dividend.payDate ? { payDate: dividend.payDate } : {}),
          recognitionDate,
          quantity,
          amountPerUnit: dividend.amount,
          unit,
          nativeCurrency: native,
          nativeAmount,
          amount: convert(nativeAmount, native, currency, fxRateOn(options.fx, recognitionDate)),
          currency,
        });
      }
    }
  }
  return receipts.sort((left, right) => compare(left.recognitionDate, right.recognitionDate) || compare(left.id, right.id));
}

// ---- History -----------------------------------------------------------------------------------

export type HistoryPoint = {
  /** YYYY-MM-DD for daily points, ISO timestamp for intraday points. */
  date: string;
  value: number;
  /** Cost basis of the positions held at that point. */
  capital: number;
  /** Value plus dividends recognized so far. */
  dividendAdjustedValue: number;
};

type SecurityCursor = {
  dates: readonly string[];
  closes: readonly number[];
  index: number;
  /** Execution price of the latest trade, today's share units, native currency; used before the first close. */
  fallback: number | null;
  unit: number;
  native: string;
  quote?: Quote;
};

/**
 * Daily portfolio value from the first included trade until `today`. The last point uses live quotes,
 * so it equals `valuePortfolio(...).summary.totalValue`.
 */
export function portfolioHistory<T extends LedgerTransaction>(book: Book<T>, options: ValuationOptions<T>): HistoryPoint[] {
  const { target, fx, today } = options;
  const include = options.include ?? (() => true);
  const trades = book.trades.filter(include);
  if (!trades.length) return [];
  const first = trades[0].date;
  const dates = new Set<string>([today]);
  const cursors = new Map<string, SecurityCursor>();
  for (const trade of trades) {
    dates.add(trade.date);
    if (cursors.has(trade.securityId)) continue;
    const history = book.market.history.get(trade.key);
    const security = book.securities.get(trade.securityId);
    for (const date of history?.dates ?? []) if (date >= first && date <= today) dates.add(date);
    cursors.set(trade.securityId, {
      dates: history?.dates ?? [],
      closes: history?.closes ?? [],
      index: -1,
      fallback: null,
      unit: priceUnitOf(security),
      native: nativeCurrencyOf(security, trade.securityId),
      quote: book.market.quotes.get(trade.key),
    });
  }
  const axis = [...dates].filter((date) => date >= first && date <= today).sort();
  const receipts = dividendReceipts(book, options);
  const groups = new Map<string, PositionState>();
  const quantities = new Map<string, number>();
  let tradeIndex = 0;
  let receiptIndex = 0;
  let dividends = 0;
  let capital = 0;
  const points: HistoryPoint[] = [];
  for (const date of axis) {
    while (tradeIndex < trades.length && trades[tradeIndex].date <= date) {
      const trade = trades[tradeIndex++];
      const cursor = cursors.get(trade.securityId)!;
      const currency = targetCurrency(target, cursor.native);
      const amount = convert(trade.amount, trade.currency, currency, fxRateOn(fx, trade.date));
      const execution = convert(trade.amount / trade.quantity, trade.currency, cursor.native, fxRateOn(fx, trade.date));
      if (execution != null && Number.isFinite(execution)) cursor.fallback = execution * cursor.unit;
      if (amount == null) continue;
      const positionKey = `${trade.securityId}\u0000${trade.group}`;
      let state = groups.get(positionKey);
      if (!state) groups.set(positionKey, state = { quantity: 0, cost: 0, realized: 0 });
      const quantityBefore = state.quantity;
      capital -= state.cost;
      applyTrade(state, trade.side, trade.quantity, amount);
      capital += state.cost;
      quantities.set(trade.securityId, (quantities.get(trade.securityId) ?? 0) + state.quantity - quantityBefore);
    }
    while (receiptIndex < receipts.length && receipts[receiptIndex].recognitionDate <= date) {
      dividends += receipts[receiptIndex++].amount ?? 0;
    }
    let value = 0;
    const rate = fxRateOn(fx, date);
    for (const [securityId, cursor] of cursors) {
      while (cursor.index + 1 < cursor.dates.length && cursor.dates[cursor.index + 1] <= date) cursor.index += 1;
      const quantity = quantities.get(securityId) ?? 0;
      if (quantity <= EPSILON) continue;
      const live = date === today && cursor.quote;
      const close = live ? cursor.quote!.price : cursor.index >= 0 ? cursor.closes[cursor.index] : cursor.fallback;
      if (close == null) continue;
      const nativeValue = (quantity * close) / cursor.unit;
      const converted = convert(nativeValue, live ? cursor.quote!.currency : cursor.native, targetCurrency(target, cursor.native), live ? fx.now : rate);
      if (converted != null) value += converted;
    }
    points.push({ date, value, capital, dividendAdjustedValue: value + dividends });
  }
  return points;
}

/**
 * Intraday portfolio value from per-security intraday prices, with the quantity held on each point's
 * date. The final point uses live quotes. `since` is unix seconds.
 */
export function intradayHistory<T extends LedgerTransaction>(book: Book<T>, options: ValuationOptions<T> & { since: number; now: number }): HistoryPoint[] {
  const { target, fx } = options;
  const include = options.include ?? (() => true);
  const intraday = book.market.intraday;
  if (!intraday) return [];
  const valuation = valuePortfolio(book, options);
  const held = valuation.holdings.filter((holding) => holding.marketValue != null);
  const series = held.map((holding) => {
    const security = book.securities.get(holding.securityId);
    const trades = (book.bySecurity.get(holding.securityId) ?? []).filter(include);
    const stepDates: string[] = [];
    const stepQuantities: number[] = [];
    let quantity = 0;
    for (const trade of trades) {
      quantity = Math.max(0, quantity + trade.side * trade.quantity);
      if (stepDates.at(-1) === trade.date) stepQuantities[stepQuantities.length - 1] = quantity;
      else {
        stepDates.push(trade.date);
        stepQuantities.push(quantity);
      }
    }
    return {
      holding,
      stepDates,
      stepQuantities,
      prices: intraday.get(holding.key),
      unit: priceUnitOf(security),
      native: nativeCurrencyOf(security, holding.securityId),
      zone: holding.quote ? zoneOf(holding.quote) : "Asia/Tokyo",
    };
  });
  const times = new Set<number>();
  for (const item of series) for (const time of item.prices?.times ?? []) if (time >= options.since && time < options.now) times.add(time);
  const axis = [...times].sort((left, right) => left - right);
  if (!axis.length) return [];
  const fxTimes = fx.intraday?.times ?? [];
  const fxPrices = fx.intraday?.prices ?? [];
  const dividendTotal = valuation.summary.dividendIncome;
  const points: HistoryPoint[] = [];
  const cursors = series.map(() => -1);
  let fxCursor = -1;
  for (const time of axis) {
    while (fxCursor + 1 < fxTimes.length && fxTimes[fxCursor + 1] <= time) fxCursor += 1;
    const rate = fxCursor >= 0 ? fxPrices[fxCursor] : fxRateOn(fx, dateInZone(time * 1000, "Asia/Tokyo")) ?? fx.now;
    let value = 0;
    series.forEach((item, index) => {
      const prices = item.prices;
      if (!prices?.times.length) {
        value += item.holding.marketValue ?? 0;
        return;
      }
      while (cursors[index] + 1 < prices.times.length && prices.times[cursors[index] + 1] <= time) cursors[index] += 1;
      const price = prices.prices[Math.max(0, cursors[index])];
      const step = lastIndexAtOrBefore(item.stepDates, dateInZone(time * 1000, item.zone));
      const quantity = step >= 0 ? item.stepQuantities[step] : 0;
      const converted = convert((quantity * price) / item.unit, item.native, targetCurrency(target, item.native), rate);
      value += converted ?? 0;
    });
    points.push({ date: new Date(time * 1000).toISOString(), value, capital: valuation.summary.costBasis, dividendAdjustedValue: value + dividendTotal });
  }
  points.push({
    date: new Date(options.now * 1000).toISOString(),
    value: valuation.summary.totalValue,
    capital: valuation.summary.costBasis,
    dividendAdjustedValue: valuation.summary.totalValue + dividendTotal,
  });
  return points;
}

export type SecurityPoint = { date: string; price: number; value: number; capital: number; quantity: number };

/** One security's daily price, position value and cost basis in `target` currency. */
export function securityHistory<T extends LedgerTransaction>(book: Book<T>, securityId: string, options: ValuationOptions<T>): SecurityPoint[] {
  const { target, fx, today } = options;
  const include = options.include ?? (() => true);
  const trades = (book.bySecurity.get(securityId) ?? []).filter(include);
  const key = trades[0]?.key ?? securityId;
  const history = book.market.history.get(key);
  const security = book.securities.get(securityId);
  const native = nativeCurrencyOf(security, securityId);
  const currency = targetCurrency(target, native);
  const unit = priceUnitOf(security);
  const quote = book.market.quotes.get(key);
  const dates = [...(history?.dates ?? [])];
  const closes = [...(history?.closes ?? [])];
  if (quote && dates.at(-1) !== today && (!dates.length || dates.at(-1)! < today)) {
    dates.push(today);
    closes.push(quote.price);
  } else if (quote && dates.at(-1) === today) closes[closes.length - 1] = quote.price;
  const groups = new Map<string, PositionState>();
  let tradeIndex = 0;
  const points: SecurityPoint[] = [];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    while (tradeIndex < trades.length && trades[tradeIndex].date <= date) {
      const trade = trades[tradeIndex++];
      const amount = convert(trade.amount, trade.currency, currency, fxRateOn(fx, trade.date));
      if (amount == null) continue;
      let state = groups.get(trade.group);
      if (!state) groups.set(trade.group, state = { quantity: 0, cost: 0, realized: 0 });
      applyTrade(state, trade.side, trade.quantity, amount);
    }
    const rate = date === today ? fx.now : fxRateOn(fx, date);
    const price = convert(closes[index], native, currency, rate);
    if (price == null) continue;
    let quantity = 0;
    let capital = 0;
    for (const state of groups.values()) {
      quantity += state.quantity;
      capital += state.cost;
    }
    points.push({ date, price, value: (quantity * price) / unit, capital, quantity });
  }
  return points;
}

// ---- Ledger rows -------------------------------------------------------------------------------

export type TradeRow = {
  /** Today's share units. */
  quantity: number;
  /** Per quoted price unit, trade currency, today's share units. */
  price: number | null;
  splitFactor: number;
  /** Holding of this security in the cost-basis group, today's share units. */
  before: number;
  after: number;
};

/** Split-normalized quantity, price and holding before/after for every position transaction. */
export function tradeRows<T extends LedgerTransaction>(book: Book<T>): Map<string, TradeRow> {
  const rows = new Map<string, TradeRow>();
  const held = new Map<string, number>();
  for (const trade of book.trades) {
    const positionKey = `${trade.securityId}\u0000${trade.group}`;
    const before = held.get(positionKey) ?? 0;
    const after = Math.max(0, before + trade.side * trade.quantity);
    held.set(positionKey, after <= EPSILON ? 0 : after);
    const raw = Math.abs(number(trade.transaction.pricePerShare));
    rows.set(trade.id, {
      quantity: trade.quantity,
      price: Number.isFinite(raw) ? raw / trade.splitFactor : null,
      splitFactor: trade.splitFactor,
      before,
      after: after <= EPSILON ? 0 : after,
    });
  }
  return rows;
}
