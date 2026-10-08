import { useCallback, useMemo } from "react";
import { dynamicChartDomain } from "@/lib/charts/chart-domain";
import { compactNumber } from "@/lib/ui/compact-number";
import { LightweightAreaChart, LightweightDonutChart, type ChartBand } from "@/components/charts/lightweight-charts";
import { marketSessionWindows, type MarketRegion, type SessionWindowKind } from "@/lib/market/market-session";
import { RefreshCw } from "lucide-react";
import { ALLOCATION_COLORS, HIDDEN_AMOUNT } from "./constants";
import { compactMoney, money, shortDateTimeJa, shortMoney, timeJa } from "./helpers";
import type { DashboardHolding, DisplayCurrency, MarketStatus } from "./types";

export function HistoryTooltip({
  point,
  showCapital,
  currency,
  amountsVisible = true,
  valueMode = "market",
}: {
  point: { date: string; value: number; dividendAdjustedValue?: number; capital: number };
  showCapital: boolean;
  currency: DisplayCurrency;
  amountsVisible?: boolean;
  valueMode?: "market" | "dividendAdjusted";
}) {
  const displayLabel = point.date.includes("T") ? shortDateTimeJa(point.date) : point.date;
  const value = valueMode === "dividendAdjusted" ? point.dividendAdjustedValue ?? point.value : point.value;
  return (
    <div className="chart-tooltip">
      <span>{displayLabel}</span>
      {showCapital && (
        <div>
          <i style={{ background: "var(--muted)" }} />
          <small>投資元本</small>
          <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
            {amountsVisible ? money(point.capital, currency) : HIDDEN_AMOUNT}
          </strong>
        </div>
      )}
      <div>
        <i style={{ background: "var(--accent)" }} />
        <small>{valueMode === "dividendAdjusted" ? "配当込み" : "評価額"}</small>
        <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
          {amountsVisible ? money(value, currency) : HIDDEN_AMOUNT}
        </strong>
      </div>
    </div>
  );
}

export function PriceTooltip({
  point,
  label,
  currency,
  tone,
}: {
  point: { date: string; price: number };
  label: string;
  currency: string;
  tone: string;
}) {
  return (
    <div className="chart-tooltip">
      <span>{point.date}</span>
      <div>
        <i style={{ background: tone }} />
        <small>{label}</small>
        <strong>{money(point.price, currency)}</strong>
      </div>
    </div>
  );
}

const SESSION_BAND: Record<SessionWindowKind, { emphasis: ChartBand["emphasis"]; priority: number; label: (market: MarketRegion) => string }> = {
  regular: { emphasis: "strong", priority: 0, label: (market) => (market === "JP" ? "東証" : "米国") },
  pts: { emphasis: "soft", priority: 1, label: () => "PTS" },
  pre_market: { emphasis: "soft", priority: 1, label: () => "プレ" },
  after_hours: { emphasis: "soft", priority: 1, label: () => "時間外" },
  lunch: { emphasis: "none", priority: 2, label: () => "昼" },
};

/** Trading sessions of the given markets between two instants, as chart bands (JP warm, US blue). */
export function sessionBands(markets: readonly MarketRegion[], fromMs: number, toMs: number): ChartBand[] {
  return markets.flatMap((market) => marketSessionWindows(market, fromMs, toMs).map((window) => {
    const style = SESSION_BAND[window.kind];
    return {
      start: window.start,
      end: window.end,
      color: market === "JP" ? "var(--session-jp)" : "var(--session-us)",
      emphasis: style.emphasis,
      priority: style.priority,
      label: style.label(market),
    };
  }));
}

const pointTime = (point: { date: string }) => Date.parse(point.date);
const compactAxisNumber = new Intl.NumberFormat("ja-JP", { maximumSignificantDigits: 3 });

export function PortfolioChart({
  history,
  historyStatus,
  compact = false,
  zeroBased = false,
  showCapital = true,
  currency = "JPY",
  amountsVisible = true,
  detailsEnabled = false,
  valueMode = "market",
  sessionMarkets,
}: {
  history: Array<{ date: string; value: number; dividendAdjustedValue?: number; capital: number }>;
  /** Intraday history only: x becomes proportional to time, with these markets' sessions shaded. */
  sessionMarkets?: readonly MarketRegion[];
  historyStatus: MarketStatus;
  compact?: boolean;
  zeroBased?: boolean;
  showCapital?: boolean;
  currency?: DisplayCurrency;
  amountsVisible?: boolean;
  detailsEnabled?: boolean;
  valueMode?: "market" | "dividendAdjusted";
}) {
  const dateSpan = history.length > 1 ? new Date(history.at(-1)!.date).getTime() - new Date(history[0].date).getTime() : 0;
  const tickLabel = (value: string) =>
    value.includes("T")
      ? dateSpan > 36 * 60 * 60_000
        ? shortDateTimeJa(value)
        : timeJa(value)
      : dateSpan <= 45 * 24 * 60 * 60_000
      ? value.slice(5, 10).replace("-", "/")
      : value.slice(2, 7);
  const pointValue = useCallback(
    (point: { value: number; dividendAdjustedValue?: number }) =>
      valueMode === "dividendAdjusted" ? point.dividendAdjustedValue ?? point.value : point.value,
    [valueMode],
  );
  const yDomain = dynamicChartDomain(
    history.map(pointValue),
    showCapital ? history.map((point) => point.capital) : [],
    { zeroBased, minimumSpread: 1 },
  );
  const axisSpread = yDomain[1] - yDomain[0];
  const yTickLabel = (value: number) => {
    const absolute = Math.abs(value);
    // Three significant digits: two made neighbouring ticks of a narrow range read the same ("240万", "240万").
    const roundedUnit = (scaledValue: number) => compactAxisNumber.format(scaledValue);
    if (compact && currency === "JPY" && absolute >= 100_000_000) return `${roundedUnit(value / 100_000_000)}億`;
    if (compact && currency === "JPY" && absolute >= 10_000) return `${roundedUnit(value / 10_000)}万`;
    if (compact && currency === "USD" && absolute >= 1_000_000) return `${roundedUnit(value / 1_000_000)}M`;
    if (compact && currency === "USD" && absolute >= 1_000) return `${roundedUnit(value / 1_000)}K`;
    if (compact) return roundedUnit(value);
    if (currency === "JPY" && absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(axisSpread < 100_000_000 ? 2 : 1)}億`;
    if (currency === "JPY" && absolute >= 10_000) return `${compactNumber(value / 10_000)}万`;
    if (currency === "USD" && absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (currency === "USD" && absolute >= 1_000) return `${compactNumber(value / 1_000)}K`;
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: currency === "USD" || axisSpread < 100 ? 2 : 0 }).format(value);
  };
  const timeAxis = Boolean(sessionMarkets && history.length > 1 && history[0].date.includes("T"));
  const bands = useMemo(
    () => (timeAxis ? sessionBands(sessionMarkets!, pointTime(history[0]), pointTime(history.at(-1)!)) : undefined),
    [history, sessionMarkets, timeAxis],
  );
  const chartSeries = useMemo(
    () => [
      ...(showCapital
        ? [
            {
              key: "capital",
              name: "投資元本",
              read: (point: { capital: number }) => point.capital,
              stroke: "var(--muted)",
              strokeWidth: 1,
              strokeDasharray: "3 3",
            },
          ]
        : []),
      {
        key: "value",
        name: valueMode === "dividendAdjusted" ? "配当込み" : "評価額",
        read: pointValue,
        stroke: "var(--accent)",
        strokeWidth: 1.7,
        fillOpacity: 0.13,
      },
    ],
    [pointValue, showCapital, valueMode],
  );

  return history.length ? (
    <LightweightAreaChart
      data={history}
      xTime={timeAxis ? pointTime : undefined}
      bands={bands}
      domain={yDomain}
      series={chartSeries}
      xValue={(point) => point.date}
      xTickFormatter={tickLabel}
      yTickFormatter={yTickLabel}
      tickCount={compact ? 4 : 5}
      yAxisWidth={amountsVisible ? (compact ? 42 : 52) : 8}
      xAxisHeight={compact ? 24 : 30}
      tickMargin={compact ? 4 : 5}
      minTickGap={compact ? 40 : 50}
      // Room above the line for the session labels.
      top={(compact ? 6 : 16) + (bands?.length ? 12 : 0)}
      right={compact ? 6 : 8}
      minHeight={compact ? 120 : 220}
      showYAxis={amountsVisible}
      detailsEnabled={detailsEnabled}
      tooltipContent={(point) => (
        <HistoryTooltip
          point={point}
          showCapital={showCapital}
          currency={currency}
          amountsVisible={amountsVisible}
          valueMode={valueMode}
        />
      )}
      ariaLabel={valueMode === "dividendAdjusted" ? "配当込みポートフォリオ投資成果の推移" : "ポートフォリオ評価額の推移"}
    />
  ) : (
    <div className="empty-state">
      <RefreshCw size={15} className={historyStatus === "loading" || historyStatus === "idle" ? "spin" : ""} />
      <span>{historyStatus === "loading" || historyStatus === "idle" ? "履歴取得中" : "履歴なし"}</span>
    </div>
  );
}

export function StockPriceChart({
  history,
  historyStatus,
  currency = "JPY",
  compact = false,
  zeroBased = false,
  label = "株価",
  detailsEnabled = false,
}: {
  history: Array<{ date: string; price: number }>;
  historyStatus: MarketStatus;
  currency?: string;
  compact?: boolean;
  zeroBased?: boolean;
  label?: string;
  detailsEnabled?: boolean;
}) {
  const dateSpan = history.length > 1 ? new Date(history.at(-1)!.date).getTime() - new Date(history[0].date).getTime() : 0;
  const tickLabel = (value: string) => (dateSpan <= 45 * 24 * 60 * 60_000 ? value.slice(5, 10).replace("-", "/") : value.slice(2, 7));
  const yDomain = dynamicChartDomain(
    history.map((point) => point.price),
    [],
    { zeroBased, nonNegative: true, minimumSpread: 0.01 },
  );
  const axisSpread = yDomain[1] - yDomain[0];
  const yTickLabel = (value: number) => {
    if (currency === "JPY" && Math.abs(value) >= 10_000) return `${compactNumber(value / 10_000)}万`;
    return new Intl.NumberFormat("ja-JP", {
      maximumFractionDigits: currency === "JPY" ? (axisSpread < 100 ? 2 : 0) : axisSpread < 10 ? 2 : 1,
    }).format(value);
  };
  const positive = (history.at(-1)?.price ?? 0) >= (history[0]?.price ?? 0);
  const tone = positive ? "var(--up)" : "var(--down)";
  const chartSeries = useMemo(
    () => [{ key: "price", name: label, read: (point: { price: number }) => point.price, stroke: tone, strokeWidth: 1.8, fillOpacity: 0.16 }],
    [label, tone],
  );

  return history.length ? (
    <LightweightAreaChart
      data={history}
      domain={yDomain}
      series={chartSeries}
      xValue={(point) => point.date}
      xTickFormatter={tickLabel}
      yTickFormatter={yTickLabel}
      tickCount={5}
      yAxisWidth={compact ? 46 : 52}
      xAxisHeight={30}
      tickMargin={5}
      minTickGap={compact ? 38 : 50}
      top={compact ? 8 : 16}
      right={compact ? 4 : 8}
      minHeight={compact ? 100 : 200}
      detailsEnabled={detailsEnabled}
      tooltipContent={(point) => <PriceTooltip point={point} label={label} currency={currency} tone={tone} />}
      ariaLabel={`${label}の推移`}
    />
  ) : (
    <div className="empty-state">
      <RefreshCw size={15} className={historyStatus === "loading" || historyStatus === "idle" ? "spin" : ""} />
      <span>{historyStatus === "loading" || historyStatus === "idle" ? "履歴取得中" : `${label}履歴なし`}</span>
    </div>
  );
}export function AllocationChart({
  holdings,
  cashValue,
  currency,
  amountsVisible = true,
}: {
  holdings: DashboardHolding[];
  cashValue: number;
  currency: DisplayCurrency;
  amountsVisible?: boolean;
}) {
  const allocation = useMemo(() => {
    const rows = holdings
      .map((holding) => ({
        name: holding.security?.name ?? holding.securityId,
        legalName: holding.security?.legalName ?? holding.security?.name ?? holding.securityId,
        symbol: holding.security?.displaySymbol ?? "",
        value: Math.max(0, holding.summaryMarketValue ?? holding.marketValue ?? 0),
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    if (cashValue > 0) rows.push({ name: "現金", legalName: "現金", symbol: currency, value: cashValue });
    if (rows.length <= 8) return rows;
    const other = rows.slice(7).reduce((total, item) => total + item.value, 0);
    return [...rows.slice(0, 7), { name: "その他", legalName: "その他", symbol: `${rows.length - 7}銘柄`, value: other }];
  }, [cashValue, holdings, currency]);

  const total = allocation.reduce((sum, item) => sum + item.value, 0);

  if (!allocation.length) {
    return <div className="empty-state">評価できる保有資産がありません</div>;
  }

  return (
    <div className="allocation-view" aria-label="資産構成比率" data-swipe-ignore="true">
      <div className="allocation-chart-wrap" data-swipe-ignore="true">
        <LightweightDonutChart
          items={allocation.map((item, index) => ({
            name: item.name,
            value: item.value,
            color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
          }))}
        />
        <div className="allocation-center">
          <strong>{amountsVisible ? shortMoney(total, currency) : HIDDEN_AMOUNT}</strong>
          <span>資産総額</span>
        </div>
      </div>

      <div className="allocation-legend-list">
        {allocation.map((item, index) => {
          const pct = total ? (item.value / total) * 100 : 0;
          return (
            <div className="allocation-legend-row" key={`${item.name}-${item.symbol}`}>
              <div className="allocation-legend-item-info">
                <i style={{ background: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length] }} />
                <div className="allocation-legend-names">
                  <strong title={item.legalName}>{item.name}</strong>
                  <small>{item.symbol}</small>
                </div>
              </div>
              <div className="allocation-legend-item-values">
                <strong className="allocation-legend-pct">{pct.toFixed(1)}%</strong>
                <span className="allocation-legend-val" aria-label={amountsVisible ? undefined : "金額非表示"}>
                  {amountsVisible ? compactMoney(item.value, currency) : HIDDEN_AMOUNT}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
