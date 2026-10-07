import { memo, useMemo, useState } from "react";
import type { TradeRow } from "@kabutora/domain/portfolio";
import { BarChart3, CalendarDays, List, Pencil, Plus, Trash2 } from "lucide-react";
import { HIDDEN_AMOUNT, MOBILE_LAYOUT_QUERY } from "./constants";
import {
  compactMoney,
  dateJa,
  isFundSecurity,
  maybeMoney,
  number,
  securityPriceBasis,
  securityQuantityUnit,
} from "./helpers";
import type {
  AccountLookup,
  DashboardAccount,
  DashboardSecurity,
  DashboardTransaction,
  DisplayCurrency,
  SecurityLookup,
} from "./types";
import { useIncrementalList, useMediaQuery } from "./use-incremental-list";

type LedgerTypeTone = "buy" | "sell" | "neutral";

/** Rows recorded before a split show today's share units; the note keeps the entered values visible. */
function SplitNote({ transaction, position, unit }: { transaction: DashboardTransaction; position?: TradeRow; unit: string }) {
  if (position && transaction.type === "SELL" && position.quantity > position.before + 1e-9) {
    return (
      <span className="ledger-split-note warning" title={`売却時点の保有数 ${number.format(position.before)}${unit} を超えています。買付の記録漏れがないか確認してください。`}>
        保有数超過
      </span>
    );
  }
  if (!position || position.splitFactor === 1) return null;
  const factor = position.splitFactor;
  const label = factor > 1 ? `分割 ×${number.format(factor)}` : `併合 ×${number.format(factor)}`;
  return (
    <span className="ledger-split-note" title={`入力値: ${number.format(Math.abs(Number(transaction.quantity)))}${unit} @ ${transaction.pricePerShare ?? "—"}（株式分割を反映して表示）`}>
      {label}
    </span>
  );
}

function ledgerTransactionPresentation(transaction: DashboardTransaction): {
  isBuy: boolean;
  isSell: boolean;
  label: string;
  tone: LedgerTypeTone;
} {
  const isBuy = transaction.type === "BUY";
  const isSell = transaction.type === "SELL";
  const label = isBuy
    ? "買付"
    : isSell
      ? "売却"
      : transaction.type === "TRANSFER_IN"
        ? "入庫"
        : transaction.type === "WITHDRAWAL"
          ? "出金"
          : "入金";
  return { isBuy, isSell, label, tone: isBuy ? "buy" : isSell ? "sell" : "neutral" };
}

export function Ledger({
  rows,
  securityMap,
  accountMap,
  tradeRows,
  onEdit,
  onDelete,
  onOpenTrade,
  amountsVisible = true,
}: {
  rows: DashboardTransaction[];
  securityMap: SecurityLookup;
  accountMap: AccountLookup;
  /** Split-normalized quantity, price and holding before/after per transaction. */
  tradeRows?: ReadonlyMap<string, TradeRow>;
  onEdit?: (transactionId: string) => void;
  onDelete?: (transactionId: string) => void;
  onOpenTrade?: () => void;
  amountsVisible?: boolean;
}) {
  const ordered = useMemo(
    () => [...rows].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.id.localeCompare(a.id)),
    [rows],
  );
  const compact = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const list = useIncrementalList(ordered.length);
  const shown = list.visible < ordered.length ? ordered.slice(0, list.visible) : ordered;

  if (!ordered.length) {
    return (
      <div className="ledger-empty panel">
        <p>取引履歴はありません</p>
        {onOpenTrade && (
          <button type="button" className="trade-button" onClick={onOpenTrade}>
            <Plus size={14} />
            <span>取引を記録</span>
          </button>
        )}
      </div>
    );
  }


  return (
    <div className="holdings-table-wrap ledger-table-wrap panel">
      {/* One layout at a time, rendered in pages: a ledger can hold thousands of rows. */}
      {compact ? (
        <div className="ledger-mobile-cards">
          {shown.map((transaction) => (
            <FastLedgerCard
              key={transaction.id}
              transaction={transaction}
              security={transaction.securityId ? securityMap.get(transaction.securityId) : null}
              account={accountMap.get(transaction.accountId)}
              position={tradeRows?.get(transaction.id)}
              onEdit={onEdit}
              onDelete={onDelete}
              amountsVisible={amountsVisible}
            />
          ))}
        </div>
      ) : (
        <table className="holdings-table ledger-table">
          <thead>
            <tr>
              <th className="ledger-date-col">日付</th>
              <th className="ledger-type-col">種別</th>
              <th className="ledger-security-col">銘柄 / 口座</th>
              <th className="ledger-quantity-col">数量</th>
              <th className="ledger-position-col">保有数推移</th>
              <th className="ledger-unit-price-col">約定単価</th>
              <th className="ledger-gross-col">約定金額</th>
              <th className="ledger-action-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((transaction) => (
              <FastLedgerTableRow
                key={transaction.id}
                transaction={transaction}
                security={transaction.securityId ? securityMap.get(transaction.securityId) : null}
                account={accountMap.get(transaction.accountId)}
                position={tradeRows?.get(transaction.id)}
                onEdit={onEdit}
                onDelete={onDelete}
                amountsVisible={amountsVisible}
              />
            ))}
          </tbody>
        </table>
      )}
      {list.hasMore && (
        <div ref={list.sentinelRef} className="ledger-more">
          <button type="button" className="text-button" onClick={list.showAll}>
            残り{ordered.length - list.visible}件を表示
          </button>
        </div>
      )}
    </div>
  );
}

export function CalendarActivity({ transactions }: { transactions: DashboardTransaction[] }) {
  const initial =
    [...transactions]
      .map((row) => row.tradeDate.slice(0, 7))
      .sort()
      .at(-1) ?? new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(initial);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1).getDay();
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const byDay = new Map<number, DashboardTransaction[]>();
  for (const row of transactions) {
    if (!row.tradeDate.startsWith(month)) continue;
    const day = Number(row.tradeDate.slice(8, 10));
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const moveMonth = (delta: number) => {
    const next = new Date(year, monthNumber - 1 + delta, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
  };
  return (
    <section className="activity-calendar panel">
      <div className="calendar-toolbar">
        <button onClick={() => moveMonth(-1)} aria-label="前の月">
          ‹
        </button>
        <strong>
          {year}年{monthNumber}月
        </strong>
        <button onClick={() => moveMonth(1)} aria-label="次の月">
          ›
        </button>
      </div>
      <div className="calendar-weekdays">
        {["日", "月", "火", "水", "木", "金", "土"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {Array.from({ length: firstDay }, (_, index) => (
          <div className="blank" key={`blank-${index}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const rows = byDay.get(day) ?? [];
          const volume = rows.reduce((sum, row) => sum + Math.abs(Number(row.grossAmount ?? 0)), 0);
          const currencies = [...new Set(rows.map((row) => row.tradeCurrency ?? "JPY"))];
          return (
            <div className={rows.length ? "active" : ""} key={day}>
              <span>{day}</span>
              {rows.length > 0 && (
                <>
                  <strong>{rows.length}件</strong>
                  <small>{currencies.length === 1 ? compactMoney(volume, currencies[0] as DisplayCurrency) : "複数通貨"}</small>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ActivityHistogram({ transactions }: { transactions: DashboardTransaction[] }) {
  const grouped = new Map<string, { count: number; volume: number; currencies: Set<string> }>();
  for (const row of transactions) {
    const month = row.tradeDate.slice(0, 7);
    const current = grouped.get(month) ?? { count: 0, volume: 0, currencies: new Set<string>() };
    current.count += 1;
    current.volume += Math.abs(Number(row.grossAmount ?? 0));
    current.currencies.add(row.tradeCurrency ?? "JPY");
    grouped.set(month, current);
  }
  const rows = [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12);
  const maxCount = Math.max(1, ...rows.map(([, value]) => value.count));
  return (
    <section className="activity-histogram panel">
      {rows.map(([month, value]) => (
        <div key={month}>
          <time>{month.replace("-", "/")}</time>
          <div>
            <i style={{ width: `${Math.max(5, (value.count / maxCount) * 100)}%` }} />
          </div>
          <strong>{value.count}件</strong>
          <span>{value.currencies.size === 1 ? compactMoney(value.volume, [...value.currencies][0] as DisplayCurrency) : "複数通貨"}</span>
        </div>
      ))}
    </section>
  );
}

export function ActivityTradeSummary({ transactions }: { transactions: DashboardTransaction[] }) {
  const stats = useMemo(() => {
    const tradeRows = transactions.filter((transaction) => transaction.type === "BUY" || transaction.type === "SELL");
    const buyRows = tradeRows.filter((transaction) => transaction.type === "BUY");
    const sellRows = tradeRows.filter((transaction) => transaction.type === "SELL");

    const buyGrossByCurrency: Record<string, number> = {};
    const sellGrossByCurrency: Record<string, number> = {};
    const netGrossByCurrency: Record<string, number> = {};

    for (const t of tradeRows) {
      const c = (t.tradeCurrency || t.currency || "JPY") as string;
      const gross = Math.abs(t.grossAmount != null ? Number(t.grossAmount) : (Number(t.quantity ?? 0) * Number(t.pricePerShare ?? 0)) / Number(t.priceUnit ?? 1));
      if (t.type === "BUY") {
        buyGrossByCurrency[c] = (buyGrossByCurrency[c] ?? 0) + gross;
        netGrossByCurrency[c] = (netGrossByCurrency[c] ?? 0) + gross;
      } else if (t.type === "SELL") {
        sellGrossByCurrency[c] = (sellGrossByCurrency[c] ?? 0) + gross;
        netGrossByCurrency[c] = (netGrossByCurrency[c] ?? 0) - gross;
      }
    }

    return {
      totalCount: tradeRows.length,
      buyCount: buyRows.length,
      sellCount: sellRows.length,
      buyGrossByCurrency,
      sellGrossByCurrency,
      netGrossByCurrency,
    };
  }, [transactions]);

  if (!transactions.length) return null;

  /** One line per currency: a joined "¥… / $…" string did not fit a phone-width chip. */
  const formatCurrencyMap = (map: Record<string, number>, fallbackZero = true) => {
    const entries = Object.entries(map).filter(([, val]) => val !== 0 || fallbackZero);
    if (!entries.length) return fallbackZero ? "¥0" : "—";
    return entries.map(([curr, val]) => <span key={curr}>{compactMoney(val, curr as DisplayCurrency, true)}</span>);
  };

  return (
    <div className="activity-summary-bar" aria-label="取引履歴サマリー">
      <div className="activity-stat-chip">
        <span className="activity-stat-label">取引</span>
        <strong className="activity-stat-val">{stats.totalCount}件</strong>
        <span className="activity-stat-sub">
          ({stats.buyCount}買/{stats.sellCount}売)
        </span>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">総買付</span>
        <strong className="activity-stat-val buy">{formatCurrencyMap(stats.buyGrossByCurrency, true)}</strong>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">総売却</span>
        <strong className="activity-stat-val sell">{formatCurrencyMap(stats.sellGrossByCurrency, true)}</strong>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">純投資額</span>
        <strong className="activity-stat-val">{formatCurrencyMap(stats.netGrossByCurrency, true)}</strong>
      </div>
    </div>
  );
}

export function ActivityView({
  transactions,
  securityMap,
  accountMap,
  tradeRows,
  brokerOptions = [],
  onEdit,
  onDelete,
  onOpenTrade,
}: {
  transactions: DashboardTransaction[];
  securityMap: SecurityLookup;
  accountMap: AccountLookup;
  tradeRows?: ReadonlyMap<string, TradeRow>;
  brokerOptions?: string[];
  onEdit?: (transactionId: string) => void;
  onDelete?: (transactionId: string) => void;
  onOpenTrade?: () => void;
}) {
  const [mode, setMode] = useState<"list" | "calendar" | "frequency">("list");
  const [activityBrokerFilter, setActivityBrokerFilter] = useState<string>("ALL");
  const [activityMarketFilter, setActivityMarketFilter] = useState<string>("ALL");

  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) => {
      const account = t.accountId ? accountMap.get(t.accountId) : null;
      const broker = account?.broker ?? t.original?.broker;
      if (activityBrokerFilter !== "ALL" && broker !== activityBrokerFilter) return false;
      if (activityMarketFilter !== "ALL") {
        const security = t.securityId ? securityMap.get(t.securityId) : null;
        if (!security) return false;
        if (activityMarketFilter === "JP" && security.country !== "JP") return false;
        if (activityMarketFilter === "US" && security.country !== "US") return false;
        if (activityMarketFilter === "FUNDS_INDEXES" && security.assetType !== "fund" && security.assetType !== "index" && security.assetType !== "etf") return false;
      }
      return true;
    });
  }, [transactions, activityBrokerFilter, activityMarketFilter, accountMap, securityMap]);

  return (
    <div className="activity-page">
      <ActivityTradeSummary transactions={filteredTransactions} />
      {mode === "list" && (
        <Ledger
          rows={filteredTransactions}
          securityMap={securityMap}
          accountMap={accountMap}
          tradeRows={tradeRows}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenTrade={onOpenTrade}
        />
      )}
      {mode === "calendar" && <CalendarActivity transactions={filteredTransactions} />}
      {mode === "frequency" && <ActivityHistogram transactions={filteredTransactions} />}

      {/* Bottom Controls: Single Row Dock with 3-Toggle Icon Buttons, Filters & Compact Plus Button */}
      <div className="activity-bottom-controls" data-swipe-ignore="true">
        <div className="segmented activity-modes" role="tablist" aria-label="取引履歴表示形式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "list"}
            aria-label="一覧"
            title="一覧"
            className={mode === "list" ? "active" : ""}
            onClick={() => setMode("list")}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "calendar"}
            aria-label="カレンダー"
            title="カレンダー"
            className={mode === "calendar" ? "active" : ""}
            onClick={() => setMode("calendar")}
          >
            <CalendarDays size={16} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "frequency"}
            aria-label="頻度"
            title="頻度"
            className={mode === "frequency" ? "active" : ""}
            onClick={() => setMode("frequency")}
          >
            <BarChart3 size={16} />
          </button>
        </div>

        <div className="activity-filters" role="group" aria-label="取引履歴フィルター">
          <select
            aria-label="証券会社で絞り込み"
            className="activity-filter-select"
            value={activityBrokerFilter}
            onChange={(e) => setActivityBrokerFilter(e.target.value)}
          >
            <option value="ALL">全口座</option>
            {brokerOptions.map((broker: string) => (
              <option key={broker} value={broker}>
                {broker.replace("証券", "")}
              </option>
            ))}
          </select>
          <select
            aria-label="資産区分で絞り込み"
            className="activity-filter-select"
            value={activityMarketFilter}
            onChange={(e) => setActivityMarketFilter(e.target.value)}
          >
            <option value="ALL">全資産</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
            <option value="FUNDS_INDEXES">投信・指数</option>
          </select>
        </div>

        {onOpenTrade && (
          <button
            type="button"
            className="trade-button activity-add-btn"
            onClick={onOpenTrade}
            aria-label="取引を追加"
            title="取引を追加"
          >
            <Plus size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

export const FastActivityView = memo(ActivityView);

const FastLedgerCard = memo(function LedgerCard({
  transaction,
  security,
  account,
  position,
  onEdit,
  onDelete,
  amountsVisible,
}: {
  transaction: DashboardTransaction;
  security?: DashboardSecurity | null;
  account?: DashboardAccount;
  position?: TradeRow;
  onEdit?: (transactionId: string) => void;
  onDelete?: (transactionId: string) => void;
  amountsVisible: boolean;
}) {
  const unit = securityQuantityUnit(security);
  const { isBuy, isSell, label: typeLabel, tone: typeTone } = ledgerTransactionPresentation(transaction);
  const transactionCurrency = transaction.tradeCurrency ?? "JPY";
  const editable = Boolean(onEdit && security && (isBuy || isSell));

  return (
    <article className="ledger-card">
      <div className="ledger-card-primary">
        <div className="ledger-card-title-group">
          <span className={`ledger-side-badge ${typeTone}`}>{typeLabel}</span>
          <strong className="ledger-card-name">{security ? security.name : "現金"}</strong>
          {security?.displaySymbol && <span className="ledger-symbol-pill">{security.displaySymbol}</span>}
        </div>
        <strong className={`ledger-card-gross ${typeTone}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
          {amountsVisible ? maybeMoney(transaction.grossAmount, transactionCurrency) : HIDDEN_AMOUNT}
        </strong>
      </div>

      <div className="ledger-card-secondary">
        <div className="ledger-card-meta">
          <time>{dateJa(transaction.tradeDate)}</time>
          {account?.name && (
            <>
              <span className="ledger-dot">·</span>
              <span className="ledger-card-account">{account.name}</span>
            </>
          )}
        </div>
        <div className="ledger-card-unit-info">
          {amountsVisible ? (
            <>
              <span className="ledger-card-qty">
                {transaction.quantity ? `${number.format(position?.quantity ?? Math.abs(Number(transaction.quantity)))}${unit}` : "—"}
              </span>
              <SplitNote transaction={transaction} position={position} unit={unit} />
              {transaction.pricePerShare != null && (
                <span className="ledger-card-at">
                  @ {maybeMoney(position?.price ?? transaction.pricePerShare, transactionCurrency)}
                  {isFundSecurity(security) ? ` / ${securityPriceBasis(security)}` : ""}
                </span>
              )}
            </>
          ) : (
            <span>{HIDDEN_AMOUNT}</span>
          )}
        </div>
      </div>

      {(position || editable || onDelete) && (
        <div className="ledger-card-footer">
          <div className="ledger-card-pos">
            {amountsVisible && position && (
              <span className="ledger-card-pos-text">
                保有推移: {number.format(position.before)} →{" "}
                <strong>
                  {number.format(position.after)}
                  {unit}
                </strong>
              </span>
            )}
          </div>
          <div className="ledger-card-actions">
            {editable && (
              <button
                type="button"
                className="ledger-action-btn edit"
                aria-label={`${security?.name ?? "銘柄"} ${dateJa(transaction.tradeDate)}を編集`}
                title="取引を編集"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit?.(transaction.id);
                }}
              >
                <Pencil size={13} />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className="ledger-action-btn delete"
                aria-label={`${security?.name ?? "取引"} ${dateJa(transaction.tradeDate)}を削除`}
                title="取引を削除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete?.(transaction.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
});

const FastLedgerTableRow = memo(function LedgerTableRow({
  transaction,
  security,
  account,
  position,
  onEdit,
  onDelete,
  amountsVisible,
}: {
  transaction: DashboardTransaction;
  security?: DashboardSecurity | null;
  account?: DashboardAccount;
  position?: TradeRow;
  onEdit?: (transactionId: string) => void;
  onDelete?: (transactionId: string) => void;
  amountsVisible: boolean;
}) {
  const unit = securityQuantityUnit(security);
  const { isBuy, isSell, label: typeLabel, tone: typeTone } = ledgerTransactionPresentation(transaction);
  const transactionCurrency = transaction.tradeCurrency ?? "JPY";
  const editable = Boolean(onEdit && security && (isBuy || isSell));

  return (
    <tr className="ledger-row">
      <td className="ledger-date-col">
        <time>{dateJa(transaction.tradeDate)}</time>
      </td>
      <td className="ledger-type-col">
        <span className={`ledger-side-badge ${typeTone}`}>{typeLabel}</span>
      </td>
      <td className="ledger-security-col">
        <div className="ledger-security-info">
          <div className="ledger-security-title">
            <strong className="ledger-security-name">{security ? security.name : "現金"}</strong>
            {security?.displaySymbol && <span className="ledger-symbol-pill">{security.displaySymbol}</span>}
          </div>
          <div className="ledger-security-meta">
            <span className="ledger-account">{account?.name ?? "口座未設定"}</span>
          </div>
        </div>
      </td>
      <td className="ledger-quantity-col">
        <span className="ledger-num" aria-label={amountsVisible ? undefined : "数量非表示"}>
          {amountsVisible ? (transaction.quantity ? `${number.format(position?.quantity ?? Math.abs(Number(transaction.quantity)))}${unit}` : "—") : HIDDEN_AMOUNT}
          {amountsVisible && <SplitNote transaction={transaction} position={position} unit={unit} />}
        </span>
      </td>
      <td className="ledger-position-col">
        <span className="ledger-position-shift" aria-label={amountsVisible ? undefined : "保有数非表示"}>
          {amountsVisible ? (
            !position ? (
              "—"
            ) : (
              <>
                <span className="ledger-pos-before">{number.format(position.before)}</span>
                <i className="ledger-arrow">→</i>
                <strong className="ledger-pos-after">
                  {number.format(position.after)}
                  {unit}
                </strong>
              </>
            )
          ) : (
            HIDDEN_AMOUNT
          )}
        </span>
      </td>
      <td className="ledger-unit-price-col">
        <span className="ledger-num" aria-label={amountsVisible ? undefined : "金額非表示"}>
          {amountsVisible ? (
            transaction.pricePerShare != null ? (
              <>
                {maybeMoney(position?.price ?? transaction.pricePerShare, transactionCurrency)}
                {isFundSecurity(security) ? ` / ${securityPriceBasis(security)}` : ""}
              </>
            ) : (
              "—"
            )
          ) : (
            HIDDEN_AMOUNT
          )}
        </span>
      </td>
      <td className="ledger-gross-col">
        <strong className={`ledger-gross-amount ${typeTone}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
          {amountsVisible ? maybeMoney(transaction.grossAmount, transactionCurrency) : HIDDEN_AMOUNT}
        </strong>
      </td>
      <td className="ledger-action-col">
        <div className="ledger-actions">
          {editable && (
            <button
              type="button"
              className="ledger-action-btn edit"
              aria-label={`${security?.name ?? "銘柄"} ${dateJa(transaction.tradeDate)}を編集`}
              title="取引を編集"
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(transaction.id);
              }}
            >
              <Pencil size={13} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="ledger-action-btn delete"
              aria-label={`${security?.name ?? "取引"} ${dateJa(transaction.tradeDate)}を削除`}
              title="取引を削除"
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(transaction.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});
