import { useMemo, useRef, useState } from "react";
import type { PortfolioNotification } from "@kabutora/domain/notifications";
import type { SecurityPoint, TradeRow } from "@kabutora/domain/portfolio";
import { marketDateTimeLabel } from "@/lib/charts/market-time";
import { marketDisplayName } from "@/lib/market/market-label";
import { isUsSecurity } from "@/lib/portfolio/portfolio-filter";
import { ArrowLeft } from "lucide-react";
import { Ledger } from "./activity-view";
import { PortfolioChart, StockPriceChart } from "./charts";
import { freshnessLabel, HIDDEN_AMOUNT } from "./constants";
import {
  compactMoney,
  filterDatedHistory,
  isFundSecurity,
  isIndexSecurity,
  maybeMoney,
  maybeSignedMoney,
  money,
  number,
  quoteSessionLabel,
  quoteTradeSourceLabel,
  securityPriceBasis,
  securityPriceUnit,
  securityQuantityUnit,
  signedPercent,
} from "./helpers";
import { NotificationRows } from "./notifications-view";
import { DateRangeControl } from "./overview-view";
import type {
  CustomDateRange,
  DashboardHolding,
  DashboardTransaction,
  DisplayCurrency,
  MarketStatus,
  RangeKey,
  RemoteQuote,
  SecurityChartMode,
  Seed,
  View,
} from "./types";

export type SecurityDetail = {
  holding: DashboardHolding;
  positionHistory: SecurityPoint[];
  priceHistory: Array<{ date: string; price: number }>;
  trades: Array<{ side: 1 | -1; quantity: number; amount: number | null }>;
  currency: string;
};

export function SecurityDetailView({
  detail,
  transactions,
  tradeRows,
  accountMap,
  historyStatus,
  onBack,
  returnView = "overview",
  currency,
  notifications,
  readNotificationIds,
  onReadNotification,
  onEditTransaction,
  onDeleteTransaction,
  amountsVisible,
}: {
  detail: SecurityDetail;
  transactions: DashboardTransaction[];
  tradeRows: ReadonlyMap<string, TradeRow>;
  accountMap: Map<string, Seed["accounts"][number]>;
  historyStatus: MarketStatus;
  onBack: () => void;
  returnView?: View;
  currency: DisplayCurrency;
  notifications: PortfolioNotification[];
  readNotificationIds: string[];
  onReadNotification: (id: string) => void;
  onEditTransaction?: (id: string) => void;
  onDeleteTransaction?: (id: string) => void;
  amountsVisible?: boolean;
}) {
  const { holding } = detail;
  const returnViewLabel =
    returnView === "watchlist" ? "検索" : returnView === "activity" ? "取引履歴" : returnView === "notifications" ? "通知" : returnView === "performance" ? "推移" : "一覧";
  const [detailTab, setDetailTab] = useState<"chart" | "activity" | "notifications">("chart");
  const [detailRange, setDetailRange] = useState<RangeKey>("ALL");
  const [detailCustomRange, setDetailCustomRange] = useState<CustomDateRange | null>(null);
  const [detailChartMode, setDetailChartMode] = useState<SecurityChartMode>(transactions.length > 0 ? "position" : "price");
  const sec = holding.security;
  const isUs = isUsSecurity(sec, holding.securityId);
  const activeCurrency = detail.currency as DisplayCurrency;
  const quote = sec?.quote as RemoteQuote | undefined;
  const fund = isFundSecurity(sec, holding.securityId);
  const index = isIndexSecurity(sec, holding.securityId);
  const stockMic = quote?.exchangeMic || sec?.exchangeMic || (isUs ? "XNAS" : "XTKS");
  const stockTz = sec?.timezone || (isUs ? "America/New_York" : "Asia/Tokyo");
  const stockCurrency = sec?.nativeCurrency ?? sec?.currency ?? activeCurrency;
  const secName = sec?.name || sec?.displaySymbol || holding.securityId;
  const secLegalName = sec?.legalName || secName;
  const secDisplaySymbol = sec?.displaySymbol || holding.securityId.replace(/^sec-(?:us-|jp-)?/i, "").toUpperCase();
  const day = holding.dayGain;
  const dayReturn = holding.dayChangeRatio;
  const gain = holding.unrealizedGain == null && !holding.realizedGain ? null : (holding.unrealizedGain ?? 0) + holding.realizedGain;
  const gainPercent = gain != null && holding.costBasis ? gain / holding.costBasis : null;
  const hasPosition = transactions.length > 0 && holding.quantity > 0;
  const tone = (value: number | null | undefined) => (value == null || value === 0 ? "" : value > 0 ? "up" : "down");
  const detailSecurityMap = new Map([[holding.securityId, sec]]);

  const performanceHistory = useMemo(() => filterDatedHistory(detail.positionHistory, detailRange, detailCustomRange), [detail.positionHistory, detailCustomRange, detailRange]);
  const priceHistory = useMemo(() => filterDatedHistory(detail.priceHistory, detailRange, detailCustomRange), [detail.priceHistory, detailCustomRange, detailRange]);
  const activeHistory = hasPosition && detailChartMode === "position" ? detail.positionHistory : detail.priceHistory;
  const today = new Date().toISOString().slice(0, 10);
  const detailDateBounds = {
    min: activeHistory[0]?.date.slice(0, 10) ?? transactions.map((transaction) => transaction.tradeDate.slice(0, 10)).sort()[0] ?? today,
    max: activeHistory.at(-1)?.date.slice(0, 10) ?? today,
  };

  const tradeSummary = useMemo(
    () =>
      ([1, -1] as const).map((side) => {
        const rows = detail.trades.filter((trade) => trade.side === side);
        const quantity = rows.reduce((sum, trade) => sum + trade.quantity, 0);
        const priced = rows.filter((trade) => trade.amount != null);
        const pricedQuantity = priced.reduce((sum, trade) => sum + trade.quantity, 0);
        const gross = priced.reduce((sum, trade) => sum + (trade.amount ?? 0), 0);
        return { type: side > 0 ? "BUY" as const : "SELL" as const, count: rows.length, quantity, averagePrice: pricedQuantity ? (gross / pricedQuantity) * securityPriceUnit(sec) : null, gross };
      }),
    [detail.trades, sec],
  );
  const unreadNotificationCount = notifications.filter((notification) => !readNotificationIds.includes(notification.id)).length;

  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const handlePageTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, textarea, [role='slider'], .segmented, svg")) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      t: performance.now(),
    };
  };

  const handlePageTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const elapsed = Math.max(1, performance.now() - touchStartRef.current.t);
    const velocityX = deltaX / elapsed;

    if (deltaX > 45 && Math.abs(deltaY) < Math.abs(deltaX) * 0.7 && (deltaX >= 60 || velocityX >= 0.3)) {
      onBack();
    }
    touchStartRef.current = null;
  };

  return (
    <div className="security-detail-page" onTouchStart={handlePageTouchStart} onTouchEnd={handlePageTouchEnd} onTouchCancel={() => { touchStartRef.current = null; }}>
      {/* 1. Header consistent with view-header */}
      <section className="view-header detail-header" aria-label="銘柄詳細ヘッダー">
        <div className="view-header-title-group detail-header-group">
          <button
            type="button"
            className="detail-back-button"
            onClick={onBack}
            aria-label={`${returnViewLabel}に戻る`}
            title={`${returnViewLabel}に戻る`}
          >
            <ArrowLeft size={16} />
            <span>{returnViewLabel}</span>
          </button>
          <div className="detail-title-block">
            <div className="detail-title-line">
              <h1 title={secLegalName}>{secName}</h1>
              <span className="detail-symbol-pill">{secDisplaySymbol}</span>
              <span className="detail-market-text">
                {marketDisplayName(sec)} · {sec?.nativeCurrency ?? sec?.currency ?? activeCurrency}
              </span>
            </div>
            <div className="detail-meta-line">
              {quote ? (
                <span className="detail-live-tag">
                  <i className="detail-live-dot" />
                  {quoteTradeSourceLabel(quote)} {marketDateTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency)}
                  <span className="detail-dot-sep">·</span>
                  {freshnessLabel[quote.freshness]}
                </span>
              ) : (
                <span className="detail-meta-text">価格未取得</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 2. Unified Summary (Matching 一覧's .daily-summary) */}
      <section className="daily-grid detail-summary-grid" aria-label="銘柄指標サマリー">
        <div className="daily-summary detail-summary">
          <div className="daily-summary-main">
            <div className="daily-stat-item primary">
              <span className="daily-stat-label">
                {fund ? `基準価額 (${activeCurrency})` : index ? `指数値 (${activeCurrency})` : `現在値 (${activeCurrency})`}
              </span>
              <strong className="daily-stat-val">{maybeMoney(holding.price, activeCurrency)}</strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">前日比</span>
              <div className="daily-stat-inline">
                <strong className={`daily-stat-val ${Number(day ?? 0) >= 0 ? "up" : "down"}`}>{dayReturn != null ? signedPercent(dayReturn) : "—"}</strong>
                {hasPosition && (
                  <small className={`daily-stat-sub ${Number(day ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                    ({amountsVisible ? maybeSignedMoney(day, activeCurrency) : HIDDEN_AMOUNT})
                  </small>
                )}
              </div>
            </div>
          </div>

          {quote && holding.extendedChangeRatio != null && quote.regularPrice != null && (
            <div className="detail-session-split" role="group" aria-label="通常取引と時間外の値動き">
              <div className="detail-session-cell">
                <span className="daily-stat-label">{quote.venueCode === "JNX" ? "東証" : "通常取引"}{quote.session === "pre_market" ? "（前日）" : ""}</span>
                <div className="daily-stat-inline">
                  <strong className={`daily-stat-val ${tone(holding.regularChangeRatio)}`}>{holding.regularChangeRatio != null ? signedPercent(holding.regularChangeRatio) : "—"}</strong>
                  {hasPosition && holding.regularGain != null && (
                    <small className={`daily-stat-sub ${tone(holding.regularGain)}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                      ({amountsVisible ? maybeSignedMoney(holding.regularGain, activeCurrency) : HIDDEN_AMOUNT})
                    </small>
                  )}
                </div>
                <small className="detail-session-price">
                  <span>{quote.venueCode === "JNX" ? "東証終値" : quote.session === "pre_market" ? "前日終値" : "終値"} {maybeMoney(quote.regularPrice, activeCurrency)}</span>
                  {quote.regularTimestamp && <span>{marketDateTimeLabel(quote.regularTimestamp, stockMic, stockTz, stockCurrency)}</span>}
                </small>
              </div>
              <div className="detail-session-cell extended">
                <span className="daily-stat-label"><b className="detail-session-chip">{quoteSessionLabel(quote)}</b>{quote.venueCode === "JNX" ? "東証終値比" : "終値比"}</span>
                <div className="daily-stat-inline">
                  <strong className={`daily-stat-val ${tone(holding.extendedChangeRatio)}`}>{signedPercent(holding.extendedChangeRatio)}</strong>
                  {hasPosition && holding.extendedGain != null && (
                    <small className={`daily-stat-sub ${tone(holding.extendedGain)}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                      ({amountsVisible ? maybeSignedMoney(holding.extendedGain, activeCurrency) : HIDDEN_AMOUNT})
                    </small>
                  )}
                </div>
                <small className="detail-session-price">
                  <span>{quoteTradeSourceLabel(quote)} {maybeMoney(holding.price, activeCurrency)}</span>
                  <span>{marketDateTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency)}</span>
                </small>
              </div>
            </div>
          )}

          <div className="daily-summary-divider" aria-hidden="true" />

          <div className="daily-summary-metrics detail-summary-metrics">
            <div className="daily-stat-item">
              <span className="daily-stat-label">{fund ? "保有口数" : "保有数"}</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "保有数非表示"}>
                {hasPosition ? (amountsVisible ? `${number.format(holding.quantity)}${securityQuantityUnit(sec, holding.securityId)}` : HIDDEN_AMOUNT) : "0株"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">平均取得</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "平均取得非表示"}>
                {hasPosition && holding.averageCost > 0
                  ? amountsVisible
                    ? `${maybeMoney(holding.averageCost, activeCurrency)}${fund ? ` / ${securityPriceBasis(sec, holding.securityId)}` : ""}`
                    : HIDDEN_AMOUNT
                  : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">評価額</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "評価額非表示"}>
                {hasPosition && (holding.marketValue ?? 0) > 0 ? (amountsVisible ? maybeMoney(holding.marketValue, activeCurrency) : HIDDEN_AMOUNT) : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">取得原価</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "取得原価非表示"}>
                {hasPosition && holding.costBasis > 0 ? (amountsVisible ? maybeMoney(holding.costBasis, activeCurrency) : HIDDEN_AMOUNT) : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">累計損益</span>
              {hasPosition ? (
                <div className="daily-stat-inline">
                  <strong className={`daily-stat-val ${Number(gain ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                    {amountsVisible ? compactMoney(Number(gain), activeCurrency, true) : HIDDEN_AMOUNT}
                  </strong>
                  <small className={`daily-stat-sub ${Number(gain ?? 0) >= 0 ? "up" : "down"}`}>({signedPercent(gainPercent, 1)})</small>
                </div>
              ) : (
                <strong className="daily-stat-val" style={{ color: "var(--muted)" }}>
                  未保有
                </strong>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Detail View Tabs (Chart / Activity / Notifications) - Clean Text, Larger Touch Target */}
      <div className="detail-tab-nav" role="tablist" aria-label="銘柄詳細メニュー切り替え">
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "chart"}
          className={`detail-tab-btn ${detailTab === "chart" ? "active" : ""}`}
          onClick={() => setDetailTab("chart")}
        >
          チャート
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "activity"}
          className={`detail-tab-btn ${detailTab === "activity" ? "active" : ""}`}
          onClick={() => setDetailTab("activity")}
        >
          取引履歴
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "notifications"}
          className={`detail-tab-btn ${detailTab === "notifications" ? "active" : ""}`}
          onClick={() => setDetailTab("notifications")}
        >
          <span>通知・イベント</span>
          {unreadNotificationCount > 0 && <span className="detail-tab-unread-dot" aria-label="未読あり" />}
        </button>
      </div>

      {/* 4. Tab Content Panes (Zero Nested Scrolling) */}
      {detailTab === "chart" && (
        <section className="detail-tab-content detail-chart-section" aria-label="チャート・値動き">
          <div className="detail-chart-toolbar">
            <div className="detail-chart-mode segmented" role="tablist" aria-label="チャート種類">
              {hasPosition && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailChartMode === "position"}
                  className={detailChartMode === "position" ? "active" : ""}
                  onClick={() => setDetailChartMode("position")}
                >
                  保有状況
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={detailChartMode === "price" || !hasPosition}
                className={detailChartMode === "price" || !hasPosition ? "active" : ""}
                onClick={() => setDetailChartMode("price")}
              >
                {fund ? "基準価額" : index ? "指数値" : "株価"}
              </button>
            </div>

            <div className="detail-range chart-range-menu">
              <div className="chart-range-presets segmented" aria-label="チャート期間">
                {(["1W", "1M", "3M", "YTD", "ALL"] as RangeKey[]).map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={detailRange === item ? "active" : ""}
                    onClick={() => setDetailRange(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <DateRangeControl
                value={detailCustomRange}
                active={detailRange === "CUSTOM"}
                min={detailDateBounds.min}
                max={detailDateBounds.max}
                onApply={(next) => {
                  setDetailCustomRange(next);
                  setDetailRange("CUSTOM");
                }}
              />
            </div>
          </div>

          <div className="detail-chart-body">
            {hasPosition && detailChartMode === "position" ? (
              <PortfolioChart
                history={performanceHistory}
                historyStatus={historyStatus}
                zeroBased={detailRange === "ALL"}
                showCapital={detailRange !== "1W"}
                compact
                currency={activeCurrency}
                amountsVisible={amountsVisible}
                detailsEnabled
              />
            ) : (
              <StockPriceChart
                history={priceHistory}
                historyStatus={historyStatus}
                currency={activeCurrency}
                zeroBased={detailRange === "ALL"}
                compact
                label={fund ? "基準価額" : index ? "指数値" : "株価"}
                detailsEnabled
              />
            )}
          </div>
        </section>
      )}

      {detailTab === "activity" && (
        <section className="detail-tab-content detail-activity-section" aria-label="取引履歴">
          <div className="detail-trade-summary-card">
            <div className="detail-trade-summary-head">
              <strong>売買集計</strong>
              <small>{currency === "NATIVE" ? `${activeCurrency}（現地通貨）` : `${currency} 換算`}</small>
            </div>
            <div className="detail-trade-summary-grid">
              {tradeSummary.map((item) => (
                <div key={item.type} className={`detail-trade-item ${item.type.toLowerCase()}`}>
                  <div className="detail-trade-item-side">
                    <span className={`trade-badge ${item.type === "BUY" ? "buy" : "sell"}`}>{item.type === "BUY" ? "買付" : "売却"}</span>
                    <strong>{item.count}件</strong>
                  </div>
                  <div className="detail-trade-item-metrics">
                    <div className="detail-trade-metric">
                      <span>数量:</span>
                      <strong aria-label={amountsVisible ? undefined : "数量非表示"}>
                        {amountsVisible ? `${number.format(item.quantity)}${securityQuantityUnit(sec, holding.securityId)}` : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                    <div className="detail-trade-metric">
                      <span>平均:</span>
                      <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
                        {amountsVisible
                          ? item.averagePrice == null
                            ? "—"
                            : `${money(item.averagePrice, activeCurrency)}${fund ? ` / ${securityPriceBasis(sec, holding.securityId)}` : ""}`
                          : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                    <div className="detail-trade-metric">
                      <span>総額:</span>
                      <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
                        {amountsVisible ? compactMoney(item.gross, activeCurrency) : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="detail-ledger-wrap">
            <Ledger
              rows={transactions}
              securityMap={detailSecurityMap}
              accountMap={accountMap}
              tradeRows={tradeRows}
              onEdit={onEditTransaction}
              onDelete={onDeleteTransaction}
              amountsVisible={amountsVisible}
            />
          </div>
        </section>
      )}

      {detailTab === "notifications" && (
        <section className="detail-tab-content detail-notifications-section" aria-label="通知・イベント">
          <div className="detail-notifications-head">
            <strong>銘柄関連の通知・イベント</strong>
            <small>{notifications.length}件</small>
          </div>
          {notifications.length > 0 ? (
            <div className="detail-notifications-list">
              <NotificationRows
                notifications={notifications}
                securityMap={detailSecurityMap}
                readIds={new Set(readNotificationIds)}
                onRead={onReadNotification}
                compact={false}
              />
            </div>
          ) : (
            <div className="detail-notifications-empty">
              <p>この銘柄に関する通知やコーポレートアクションはありません</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
