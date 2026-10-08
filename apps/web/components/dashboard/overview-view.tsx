import { memo, useMemo, useState } from "react";
import type { MarketRegion, MarketSessionStatus } from "@/lib/market/market-session";
import { shiftCalendarMonths } from "@/lib/ui/calendar-time";
import type { PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import { AlertTriangle, CalendarDays, Eye, EyeOff, X } from "lucide-react";
import { AllocationChart, PortfolioChart } from "./charts";
import { HIDDEN_AMOUNT, PORTFOLIO_RANGES, rangeLabel } from "./constants";
import { benchmarkNumber, compactMoney, formatDayGainMoney, fxNumber, maybeMoney, signedPercent } from "./helpers";
import { HoldingsTable } from "./holdings-table";
import { useModalFocus } from "./use-modal-focus";
import { MarketSessionIndicator } from "./market-session-indicator";
import type {
  Benchmark,
  CustomDateRange,
  DashboardHistoryPoint,
  DashboardHolding,
  DashboardSummary,
  DisplayCurrency,
  MarketStatus,
  RangeKey,
} from "./types";

export function DateRangeControl({
  value,
  active,
  min,
  max,
  onApply,
}: {
  value: CustomDateRange | null;
  active: boolean;
  min: string;
  max: string;
  onApply: (value: CustomDateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? min);
  const [to, setTo] = useState(value?.to ?? max);
  const dialogRef = useModalFocus<HTMLFormElement>(open, () => setOpen(false));
  const openDialog = () => {
    const suggestedTo = value?.to ?? max;
    const suggestedFrom = shiftCalendarMonths(suggestedTo, -3);
    setFrom(value?.from ?? (suggestedFrom < min ? min : suggestedFrom));
    setTo(suggestedTo);
    setOpen(true);
  };
  const valid = Boolean(from && to && from <= to && from >= min && to <= max);
  return (
    <>
      <button
        type="button"
        className={`date-range-trigger ${active ? "active" : ""}`}
        aria-label="日付範囲を指定"
        aria-pressed={active}
        aria-haspopup="dialog"
        title={active && value ? `${value.from}–${value.to}` : "日付範囲を指定"}
        onClick={openDialog}
      >
        <CalendarDays size={16} />
      </button>
      {open && (
        <div
          className="date-range-layer"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <form
            ref={dialogRef}
            tabIndex={-1}
            className="date-range-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="date-range-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              onApply({ from, to });
              setOpen(false);
            }}
          >
            <div className="modal-head">
              <div>
                <span>DATE RANGE</span>
                <h2 id="date-range-title">表示期間を指定</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="閉じる">
                <X size={18} />
              </button>
            </div>
            <div className="date-range-fields">
              <label>
                開始日
                <input type="date" value={from} min={min} max={to || max} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <span>—</span>
              <label>
                終了日
                <input type="date" value={to} min={from || min} max={max} onChange={(event) => setTo(event.target.value)} />
              </label>
            </div>
            <div className="date-range-bounds">
              選択可能: {min.replaceAll("-", "/")}–{max.replaceAll("-", "/")}
            </div>
            {from > to && <p className="form-error">終了日は開始日以降にしてください。</p>}
            <div className="date-range-actions">
              <button type="button" className="secondary-button" onClick={() => setOpen(false)}>
                キャンセル
              </button>
              <button type="submit" className="trade-button" disabled={!valid}>
                適用
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

const toneOf = (value: number | null | undefined) => (value == null || value === 0 ? "" : value > 0 ? "up" : "down");

/**
 * One cell of the summary breakdown: the label line carries the return rate, the value sits below.
 * 含み + 売却 + 配当 = 通算, so the realized total is not repeated as its own cell.
 */
function SummaryCell({ label, value, rate, currency, amountsVisible, total = false }: {
  label: string;
  value: number | null | undefined;
  rate?: number | null;
  currency: "JPY" | "USD";
  amountsVisible: boolean;
  total?: boolean;
}) {
  return (
    <div className={`daily-stat-item summary-cell${total ? " total" : ""}`}>
      <span className="summary-cell-head">
        <span className="daily-stat-label">{label}</span>
        {rate != null && <small className={`summary-cell-rate ${toneOf(rate)}`}>{signedPercent(rate, 1)}</small>}
      </span>
      <strong className={`daily-stat-val ${toneOf(value)}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
        {amountsVisible ? (value == null ? "—" : compactMoney(value, currency, true)) : HIDDEN_AMOUNT}
      </strong>
    </div>
  );
}

export function FxRates({ benchmarks, status }: { benchmarks: Benchmark[]; status: MarketStatus }) {
  const ordered = ["usd-jpy", "cny-jpy"].map((id) => benchmarks.find((item) => item.id === id)).filter(Boolean) as Benchmark[];
  return (
    <section className={`market-fx-panel${ordered.length ? "" : " loading"}`} aria-label="為替レート">
      {ordered.length ? (
        ordered.map((item) => (
          <span className="market-fx-item" key={item.id}>
            <small>{item.label}</small>
            <strong>{fxNumber.format(item.value)}</strong>
          </span>
        ))
      ) : (
        <span>{status === "loading" ? "FX取得中" : "FX —"}</span>
      )}
    </section>
  );
}

export function MarketTape({ benchmarks, status }: { benchmarks: Benchmark[]; status: MarketStatus }) {
  const ordered = ["sp500", "nasdaq", "dow", "nikkei225", "topix"].map((id) => benchmarks.find((item) => item.id === id)).filter(Boolean) as Benchmark[];
  if (!ordered.length)
    return (
      <section className="market-tape loading" aria-label="主要市場指標">
        <span>{status === "loading" ? "主要指標を取得中…" : "主要指標は現在取得できません"}</span>
      </section>
    );
  const tapeSet = (copy: number) => (
    <div className="market-tape-set" aria-hidden={copy > 0 || undefined} key={`tape-${copy}`}>
      {ordered.map((item) => (
        <div className="market-tape-item" key={`${copy}-${item.id}`}>
          <span className="market-tape-name">{item.label}</span>
          <div className="market-tape-data">
            <strong>{benchmarkNumber.format(item.value)}</strong>
            <small className={Number(item.changeRatio ?? 0) >= 0 ? "up" : "down"}>{signedPercent(item.changeRatio)}</small>
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <section className="market-tape" aria-label="主要市場指標" tabIndex={0}>
      <div className="market-tape-track">{[0, 1, 2, 3].map(tapeSet)}</div>
    </section>
  );
}

export function Overview({
  summary,
  holdings,
  history,
  historyStatus,
  quoteStatus,
  marketSessions,
  marketError,
  historyError,
  benchmarks,
  range,
  setRange,
  customRange,
  setCustomRange,
  dateBounds,
  marketFilter,
  setMarketFilter,
  brokerFilter,
  setBrokerFilter,
  brokerOptions = [],
  setDisplayCurrency,
  refreshMarket,
  onSelectSecurity,
  currency,
  summaryCurrency,
  amountsVisible,
  setAmountsVisible,
}: {
  summary: DashboardSummary;
  holdings: DashboardHolding[];
  history: DashboardHistoryPoint[];
  historyStatus: MarketStatus;
  quoteStatus: MarketStatus;
  marketSessions: MarketSessionStatus[];
  marketError: string | null;
  historyError: string | null;
  benchmarks: Benchmark[];
  range: RangeKey;
  setRange: (range: RangeKey) => void;
  customRange: CustomDateRange | null;
  setCustomRange: (customRange: CustomDateRange | null) => void;
  dateBounds: { min: string; max: string };
  marketFilter: PortfolioFilter;
  setMarketFilter: (marketFilter: PortfolioFilter) => void;
  brokerFilter: string;
  setBrokerFilter: (brokerFilter: string) => void;
  brokerOptions?: string[];
  setDisplayCurrency: (currency: DisplayCurrency) => void;
  refreshMarket: (force?: boolean) => Promise<void>;
  onSelectSecurity?: (securityId: string) => void;
  currency: DisplayCurrency;
  summaryCurrency: "JPY" | "USD";
  amountsVisible: boolean;
  setAmountsVisible: (visible: boolean) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [chartValueMode, setChartValueMode] = useState<"market" | "dividendAdjusted">("market");
  const benchmarkStatus = quoteStatus;
  const activeSummaryCurrency = summaryCurrency;
  const dataError = historyError || marketError;
  const unpricedCount = summary.unpricedCount;
  const showCriticalAlert = quoteStatus !== "loading" && (summary.fxMissing || Boolean(dataError) || unpricedCount > 0);
  const priced = summary.pricedCount > 0 || !holdings.length;
  const effectiveTotalValue = priced ? summary.totalValue : null;
  const effectiveDayGain = priced ? summary.dayGain : null;
  const effectiveDayReturn = priced ? summary.dayReturn : null;
  const effectiveUnrealized = priced ? summary.unrealizedGain : null;
  const effectiveCostBasis = summary.costBasis;
  const effectiveTotalGain = priced ? summary.totalGain : null;
  const effectiveTotalReturn = priced ? summary.totalReturn : null;
  // 1D chart: shade the sessions of the markets whose stocks are shown (funds and indexes have none).
  const sessionMarkets = useMemo<MarketRegion[] | undefined>(() => {
    if (range !== "1D") return undefined;
    const venues = new Set(holdings.map((holding) => holding.quote?.venue));
    return [...(venues.has("TSE") || venues.has("JNX") ? ["JP" as const] : []), ...(venues.has("US") ? ["US" as const] : [])];
  }, [holdings, range]);

  return (
    <div className={`overview-page ${isExpanded ? "chart-expanded" : ""}`}>
      <div className="market-overview-strip">
        <div className="market-session-panel">
          <MarketSessionIndicator sessions={marketSessions as MarketSessionStatus[]} quoteStatus={quoteStatus} />
        </div>
        <FastFxRates benchmarks={benchmarks} status={benchmarkStatus} />
        <FastMarketTape benchmarks={benchmarks} status={benchmarkStatus} />
      </div>
      <section className="daily-grid" aria-label="ポートフォリオサマリー">
        <div className="daily-summary">
          <div className="daily-summary-main">
            <div className="daily-stat-item primary">
              <span className="daily-stat-label">総評価</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "金額非表示"}>
                {amountsVisible ? maybeMoney(effectiveTotalValue, activeSummaryCurrency) : HIDDEN_AMOUNT}
              </strong>
            </div>
            <div className="daily-stat-item day">
              <span className="daily-stat-label">本日</span>
              <div className="daily-stat-inline">
                <strong className={`daily-stat-val ${Number(effectiveDayGain ?? 0) >= 0 ? "up" : "down"}`}>{signedPercent(effectiveDayReturn)}</strong>
                <small
                  className={`daily-stat-sub ${Number(effectiveDayGain ?? 0) >= 0 ? "up" : "down"}`}
                  aria-label={amountsVisible ? undefined : "金額非表示"}
                >
                  ({amountsVisible ? (effectiveDayGain == null ? "—" : formatDayGainMoney(effectiveDayGain, activeSummaryCurrency)) : HIDDEN_AMOUNT})
                </small>
              </div>
            </div>
          </div>
          <div className="daily-summary-divider" aria-hidden="true" />
          <div className="daily-summary-metrics summary-breakdown">
            <SummaryCell label="含み損益" value={effectiveUnrealized} rate={effectiveCostBasis > 0 && effectiveUnrealized != null ? effectiveUnrealized / effectiveCostBasis : null} currency={activeSummaryCurrency} amountsVisible={amountsVisible} />
            <SummaryCell label="売却損益" value={summary.realizedGain} currency={activeSummaryCurrency} amountsVisible={amountsVisible} />
            <SummaryCell label="配当金" value={summary.dividendIncome} currency={activeSummaryCurrency} amountsVisible={amountsVisible} />
            <SummaryCell label="通算損益" value={effectiveTotalGain} rate={effectiveTotalReturn} currency={activeSummaryCurrency} amountsVisible={amountsVisible} total />
          </div>
        </div>

        <div className={`daily-performance ${isExpanded ? "expanded" : ""}`} data-swipe-ignore="true">
          <div className="daily-performance-toolbar">
            <div className="daily-range chart-range-menu">
              <div className="chart-range-presets segmented" aria-label="表示期間">
                {PORTFOLIO_RANGES.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={range === item ? "active" : ""}
                    onClick={() => setRange(item)}
                  >
                    {rangeLabel(item)}
                  </button>
                ))}
              </div>
              <DateRangeControl
                value={customRange}
                active={range === "CUSTOM"}
                min={dateBounds.min}
                max={dateBounds.max}
                onApply={(next: CustomDateRange) => {
                  setCustomRange(next);
                  setRange("CUSTOM");
                }}
              />
            </div>
            <div className="daily-metric-toggle chart-range-presets segmented" role="group" aria-label="チャート指標">
              <button
                type="button"
                className={chartValueMode === "market" ? "active" : ""}
                aria-pressed={chartValueMode === "market"}
                onClick={() => setChartValueMode("market")}
              >
                評価額
              </button>
              <button
                type="button"
                className={chartValueMode === "dividendAdjusted" ? "active" : ""}
                aria-pressed={chartValueMode === "dividendAdjusted"}
                onClick={() => setChartValueMode("dividendAdjusted")}
              >
                配当込み
              </button>
            </div>
          </div>

          {isExpanded ? (
            <div className="daily-expanded-body" data-swipe-ignore="true">
              <div className="daily-chart expanded" data-swipe-ignore="true">
                <PortfolioChart
                  history={history}
                  historyStatus={historyStatus}
                  zeroBased={range === "ALL"}
                  showCapital={range !== "1D" && range !== "1W"}
                  currency={activeSummaryCurrency}
                  amountsVisible={amountsVisible}
                  detailsEnabled
                  valueMode={chartValueMode}
                  sessionMarkets={sessionMarkets}
                />
              </div>
              <div className="daily-allocation-divider" />
              <AllocationChart
                holdings={holdings}
                cashValue={0}
                currency={activeSummaryCurrency}
                amountsVisible={amountsVisible}
              />
              <div className="daily-expanded-floating-close" data-swipe-ignore="true">
                <button
                  type="button"
                  className="daily-expanded-close-bar"
                  onClick={() => setIsExpanded(false)}
                  aria-label="閉じる"
                >
                  <X size={16} />
                  <span>閉じる</span>
                </button>
              </div>
            </div>
          ) : (
            <div
              className="daily-chart clickable"
              data-swipe-ignore="true"
              onClick={() => setIsExpanded(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIsExpanded(true);
                }
              }}
              aria-label="クリックしてチャートを拡大"
              title="クリックしてチャートを拡大"
            >
              <PortfolioChart
                history={history}
                historyStatus={historyStatus}
                zeroBased={range === "ALL"}
                showCapital={range !== "1D" && range !== "1W"}
                compact
                currency={activeSummaryCurrency}
                amountsVisible={amountsVisible}
                valueMode={chartValueMode}
                sessionMarkets={sessionMarkets}
              />
            </div>
          )}
        </div>

        {!isExpanded && (
          <section className="daily-holdings" aria-label={`保有銘柄 ${holdings.length}件`}>
            <HoldingsTable holdings={holdings} dense onSelect={onSelectSecurity} currency={currency} amountsVisible={amountsVisible} />
          </section>
        )}

        {showCriticalAlert && (
          <div className="market-alert overview-critical-alert" role="status">
            <AlertTriangle size={15} />
            <span>{summary.fxMissing ? "為替レートを確認できないため、一部の換算を合計に含めていません" : dataError || `${unpricedCount}銘柄が未評価`}</span>
            <button
              type="button"
              onClick={() => {
                void refreshMarket(true);
              }}
            >
              再試行
            </button>
          </div>
        )}

      </section>

      {/* Floating Bottom Controls Dock matching search/watchlist and notifications */}
      <div className="overview-bottom-controls" data-swipe-ignore="true">
        <div className="overview-filters" role="group" aria-label="ポートフォリオ表示フィルター">
          <select
            aria-label="証券会社で絞り込み"
            className="overview-filter-select"
            value={brokerFilter}
            onChange={(event) => setBrokerFilter(event.target.value)}
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
            className="overview-filter-select"
            value={marketFilter}
            onChange={(event) => setMarketFilter(event.target.value as PortfolioFilter)}
          >
            <option value="ALL">全資産</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
            <option value="FUNDS_INDEXES">投信・指数</option>
          </select>
          <select
            aria-label="表示通貨"
            className="overview-filter-select"
            value={currency}
            onChange={(event) => setDisplayCurrency(event.target.value as DisplayCurrency)}
          >
            <option value="JPY">JPY</option>
            <option value="USD">USD</option>
            <option value="NATIVE">現地通貨</option>
          </select>
        </div>
        <button
          type="button"
          className="trade-button overview-visibility-toggle-btn"
          aria-label={amountsVisible ? "金額を非表示" : "金額を表示"}
          title={amountsVisible ? "金額を非表示" : "金額を表示"}
          onClick={() => setAmountsVisible(!amountsVisible)}
        >
          {amountsVisible ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      </div>
    </div>
  );
}

export const FastOverview = memo(Overview);
export const FastFxRates = memo(FxRates);
export const FastMarketTape = memo(MarketTape);
