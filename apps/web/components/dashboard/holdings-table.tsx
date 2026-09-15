import { useBrowserPreferences } from "../browser-preferences";
import { memo, useEffect, useMemo, useState } from "react";
import { canonicalDomainSecurityId, type IntradayBar, type MarketBar } from "@kabutora/domain";
import { marketDateTimeLabel, marketTimeLabel } from "@/lib/chart-presentation";
import { marketDisplayName } from "@/lib/market-label";
import { isUsSecurity, type PortfolioFilter } from "@/lib/portfolio-filter";
import { LayoutGrid, List } from "lucide-react";
import { freshnessLabel, HIDDEN_AMOUNT } from "./constants";
import {
  compactMoney,
  isFundSecurity,
  maybeMoney,
  maybeSignedMoney,
  money,
  number,
  securityPriceBasis,
  securityQuantityUnit,
  shortDateTimeJa,
  signedPercent,
} from "./helpers";
import type { DashboardHolding, DisplayCurrency, RemoteQuote } from "./types";

export type HoldingsViewMode = "grid" | "table";

export type HoldingsSort =
  | "VALUE_DESC"
  | "DAY_DESC"
  | "GAIN_DESC"
  | "DAY_GAIN_VALUE_DESC"
  | "PRICE_DESC"
  | "NAME_ASC";

export function HoldingsTable({
  holdings,
  totalValue,
  intradayBySecurity,
  dailyHistoryBySecurity,
  marketFilter = "ALL",
  dense = false,
  onSelect,
  currency,
  amountsVisible = true,
  currentTime,
}: {
  holdings: DashboardHolding[];
  totalValue: number | null;
  intradayBySecurity?: Map<string, IntradayBar[]>;
  dailyHistoryBySecurity?: Map<string, MarketBar[]>;
  marketFilter?: PortfolioFilter;
  dense?: boolean;
  onSelect?: (securityId: string) => void;
  currency: DisplayCurrency;
  amountsVisible?: boolean;
  currentTime?: number | null;
}) {
  const preferenceStorage = useBrowserPreferences();
  const [sortBy, setSortBy] = useState<HoldingsSort>(() => {
    if (typeof window === "undefined") return "VALUE_DESC";
    try {
      const saved = preferenceStorage.getItem("kabutora-holdings-sort") as HoldingsSort | null;
      if (saved && ["VALUE_DESC", "DAY_DESC", "GAIN_DESC", "DAY_GAIN_VALUE_DESC", "PRICE_DESC", "NAME_ASC"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "VALUE_DESC";
  });

  useEffect(() => {
    try {
      preferenceStorage.setItem("kabutora-holdings-sort", sortBy);
    } catch {}
  }, [sortBy]);

  const [viewMode, setViewMode] = useState<HoldingsViewMode>(() => {
    if (typeof window === "undefined") return "grid";
    try {
      const saved = preferenceStorage.getItem("kabutora-holdings-view-mode") as HoldingsViewMode | null;
      if (saved === "table" || saved === "grid") return saved;
    } catch {}
    return "grid";
  });

  useEffect(() => {
    try {
      preferenceStorage.setItem("kabutora-holdings-view-mode", viewMode);
    } catch {}
  }, [viewMode, preferenceStorage]);

  const sortedHoldings = useMemo(() => {
    const list = [...holdings];
    return list.sort((a, b) => {
      const aVal = a.marketValue == null ? -Infinity : Number(a.marketValue);
      const bVal = b.marketValue == null ? -Infinity : Number(b.marketValue);

      const aQuote = a.security?.quote as RemoteQuote | undefined;
      const bQuote = b.security?.quote as RemoteQuote | undefined;

      const aPrice = a.currentPrice == null ? null : Number(a.currentPrice);
      const bPrice = b.currentPrice == null ? null : Number(b.currentPrice);

      const aPrev = aQuote?.previousRegularClose == null ? null : Number(aQuote.previousRegularClose);
      const bPrev = bQuote?.previousRegularClose == null ? null : Number(bQuote.previousRegularClose);

      const aDayPct = aPrice != null && aPrev ? aPrice / aPrev - 1 : a.dayGain == null ? -Infinity : Number(a.dayGain);
      const bDayPct = bPrice != null && bPrev ? bPrice / bPrev - 1 : b.dayGain == null ? -Infinity : Number(b.dayGain);

      const aDayGain = a.dayGain == null ? -Infinity : Number(a.dayGain);
      const bDayGain = b.dayGain == null ? -Infinity : Number(b.dayGain);

      const aCost = Number(a.totalCost || 0);
      const bCost = Number(b.totalCost || 0);

      const aGainPct = a.unrealizedGain != null && aCost ? Number(a.unrealizedGain) / aCost : -Infinity;
      const bGainPct = b.unrealizedGain != null && bCost ? Number(b.unrealizedGain) / bCost : -Infinity;

      switch (sortBy) {
        case "VALUE_DESC":
          return bVal - aVal;
        case "DAY_DESC":
          return bDayPct - aDayPct;
        case "GAIN_DESC":
          return bGainPct - aGainPct;
        case "DAY_GAIN_VALUE_DESC":
          return bDayGain - aDayGain;
        case "PRICE_DESC":
          return (bPrice ?? -Infinity) - (aPrice ?? -Infinity);
        case "NAME_ASC":
          return (a.security?.name || a.security?.symbol || "").localeCompare(b.security?.name || b.security?.symbol || "", "ja");
        default:
          return bVal - aVal;
      }
    });
  }, [holdings, sortBy]);

  const sortIndicator = (key: HoldingsSort) => {
    if (sortBy === key)
      return (
        <span className="sort-arrow active" aria-hidden="true">
          ↓
        </span>
      );
    return null;
  };

  return (
    <div className={`holdings-table ${dense ? "dense" : ""} ${viewMode === "grid" ? "grid-view" : "table-view"}`}>
      <div className="holdings-toolbar" role="toolbar" aria-label="保有銘柄ツールバー">
        <div className="holdings-toolbar-sorts" role="group" aria-label="並び替え">
          <button
            type="button"
            className={`holdings-toolbar-sort-btn ${sortBy === "NAME_ASC" ? "active" : ""}`}
            onClick={() => setSortBy("NAME_ASC")}
          >
            銘柄 {sortIndicator("NAME_ASC")}
          </button>
          <button
            type="button"
            className={`holdings-toolbar-sort-btn ${sortBy === "PRICE_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("PRICE_DESC")}
          >
            現在値 {sortIndicator("PRICE_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-toolbar-sort-btn ${sortBy === "DAY_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("DAY_DESC")}
          >
            前日比 {sortIndicator("DAY_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-toolbar-sort-btn ${sortBy === "VALUE_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("VALUE_DESC")}
          >
            評価額 {sortIndicator("VALUE_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-toolbar-sort-btn ${sortBy === "GAIN_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("GAIN_DESC")}
          >
            含み損益 {sortIndicator("GAIN_DESC")}
          </button>
        </div>
        <div className="holdings-view-mode-toggle" role="group" aria-label="表示形式">
          <button
            type="button"
            className={`holdings-view-mode-btn ${viewMode === "grid" ? "active" : ""}`}
            aria-pressed={viewMode === "grid"}
            aria-label="グリッド表示"
            title="グリッド表示"
            onClick={() => setViewMode("grid")}
          >
            <LayoutGrid size={15} />
          </button>
          <button
            type="button"
            className={`holdings-view-mode-btn ${viewMode === "table" ? "active" : ""}`}
            aria-pressed={viewMode === "table"}
            aria-label="テーブル表示"
            title="テーブル表示"
            onClick={() => setViewMode("table")}
          >
            <List size={15} />
          </button>
        </div>
      </div>

      <div className="holdings-mobile-header" role="row">
        <div className="holdings-mobile-sorts">
          <button type="button" className={`mobile-sort-btn ${sortBy === "NAME_ASC" ? "active" : ""}`} onClick={() => setSortBy("NAME_ASC")}>
            銘柄 {sortIndicator("NAME_ASC")}
          </button>
          <button type="button" className={`mobile-sort-btn ${sortBy === "DAY_DESC" ? "active" : ""}`} onClick={() => setSortBy("DAY_DESC")}>
            前日比 {sortIndicator("DAY_DESC")}
          </button>
          <button
            type="button"
            className={`mobile-sort-btn ${sortBy === "VALUE_DESC" || sortBy === "GAIN_DESC" ? "active" : ""}`}
            onClick={() => setSortBy(sortBy === "VALUE_DESC" ? "GAIN_DESC" : "VALUE_DESC")}
          >
            {sortBy === "GAIN_DESC" ? "含み損益" : "評価額"}{" "}
            <span className="sort-arrow active" aria-hidden="true">
              ↓
            </span>
          </button>
        </div>
        <div className="holdings-mobile-view-toggle" role="group" aria-label="表示形式">
          <button
            type="button"
            className={`mobile-view-btn ${viewMode === "grid" ? "active" : ""}`}
            aria-pressed={viewMode === "grid"}
            aria-label="グリッド表示"
            title="グリッド表示"
            onClick={() => setViewMode("grid")}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            className={`mobile-view-btn ${viewMode === "table" ? "active" : ""}`}
            aria-pressed={viewMode === "table"}
            aria-label="テーブル表示"
            title="テーブル表示"
            onClick={() => setViewMode("table")}
          >
            <List size={14} />
          </button>
        </div>
      </div>

      <table className={`holdings-table-content ${viewMode === "grid" ? "is-grid" : "is-table"}`}>
        <thead>
          <tr>
            <th className={`sortable ${sortBy === "NAME_ASC" ? "active-sort" : ""}`} onClick={() => setSortBy("NAME_ASC")}>
              銘柄 {sortIndicator("NAME_ASC")}
            </th>
            <th className={`sortable ${sortBy === "PRICE_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("PRICE_DESC")}>
              現在値 {sortIndicator("PRICE_DESC")}
            </th>
            <th className={`sortable ${sortBy === "DAY_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("DAY_DESC")}>
              前日比 {sortIndicator("DAY_DESC")}
            </th>
            <th>保有数 / 平均</th>
            <th className={`sortable ${sortBy === "VALUE_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("VALUE_DESC")}>
              評価額 {sortIndicator("VALUE_DESC")}
            </th>
            <th className={`sortable ${sortBy === "GAIN_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("GAIN_DESC")}>
              含み損益率 {sortIndicator("GAIN_DESC")}
            </th>
            <th>比率</th>
          </tr>
        </thead>
        <tbody className={viewMode === "grid" ? "holdings-grid-body" : ""}>
          {sortedHoldings.map((holding) => {
            const canonicalId = canonicalDomainSecurityId(holding.securityId);
            return (
              <FastHoldingsTableRow
                key={holding.securityId}
                holding={holding}
                currency={currency}
                amountsVisible={amountsVisible}
                totalValue={totalValue}
                intraday={intradayBySecurity?.get(holding.securityId) ?? intradayBySecurity?.get(canonicalId) ?? intradayBySecurity?.get(`${canonicalId}-xtks`)}
                dailyHistory={dailyHistoryBySecurity?.get(holding.securityId) ?? dailyHistoryBySecurity?.get(canonicalId) ?? dailyHistoryBySecurity?.get(`${canonicalId}-xtks`)}
                marketFilter={marketFilter}
                onSelect={onSelect}
                currentTime={currentTime}
                viewMode={viewMode}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const FastHoldingsTableRow = memo(function FastHoldingsTableRow({
  holding,
  currency,
  amountsVisible,
  totalValue,
  intraday = [],
  dailyHistory = [],
  marketFilter = "ALL",
  onSelect,
  currentTime,
  viewMode = "grid",
}: {
  holding: DashboardHolding;
  currency: DisplayCurrency;
  amountsVisible: boolean;
  totalValue: number | null;
  intraday?: IntradayBar[];
  dailyHistory?: MarketBar[];
  marketFilter?: PortfolioFilter;
  onSelect?: (securityId: string) => void;
  currentTime?: number | null;
  viewMode?: HoldingsViewMode;
}) {
  const sec = holding.security;
  const isUs = isUsSecurity(sec, holding.securityId);
  const rowCurrency = (
    currency === "NATIVE"
      ? sec?.currency ?? sec?.nativeCurrency ?? (isUs ? "USD" : "JPY")
      : currency
  ) as DisplayCurrency;
  const quote = (sec?.quote ?? holding.quote) as RemoteQuote | undefined;
  const price = holding.currentPrice == null ? null : Number(holding.currentPrice);
  const previous = quote?.previousRegularClose == null ? null : Number(quote.previousRegularClose);
  const day = holding.dayGain == null ? null : Number(holding.dayGain);
  const dayPercent = price != null && previous ? price / previous - 1 : null;
  const gain = holding.unrealizedGain == null ? null : Number(holding.unrealizedGain);
  const gainPercent = gain != null && Number(holding.totalCost) ? gain / Number(holding.totalCost) : null;
  const stockMic = quote?.exchangeMic || sec?.exchangeMic || (isUs ? "XNAS" : "XTKS");
  const stockTz = sec?.timezone || (isUs ? "America/New_York" : "Asia/Tokyo");
  const stockCurrency = sec?.nativeCurrency ?? quote?.currency ?? sec?.currency ?? rowCurrency;
  const stockCountry = sec?.country || (isUs ? "US" : "JP");
  const secName = sec?.name || sec?.displaySymbol || holding.securityId;
  const secLegalName = sec?.legalName || secName;
  const secDisplaySymbol = sec?.displaySymbol || holding.securityId.replace(/^sec-(?:us-|jp-)?/i, "").toUpperCase();
  const weightVal = holding.summaryMarketValue ?? holding.marketValue;

  if (viewMode === "grid") {
    const fetchedTime = quote?.fetchedAt
      ? shortDateTimeJa(quote.fetchedAt)
      : quote?.marketTimestamp
      ? marketDateTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency)
      : null;

    return (
      <tr
        className={`holding-widget-card ${onSelect ? "selectable" : ""}`}
        onClick={() => onSelect?.(holding.securityId)}
        onKeyDown={(event) => {
          if (onSelect && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onSelect(holding.securityId);
          }
        }}
        tabIndex={onSelect ? 0 : undefined}
        aria-label={onSelect ? `${secName}の詳細を開く` : undefined}
      >
        <td className="widget-card-cell" colSpan={7}>
          {/* 1. Ticker Name + Daily Percentage Change */}
          <div className="widget-card-top">
            <div className="security-col widget-ticker-group">
              <strong className="widget-ticker">{secDisplaySymbol}</strong>
              {secName !== secDisplaySymbol && (
                <span className="widget-subname" title={secLegalName}>
                  {secName}
                </span>
              )}
            </div>
            <div className={`day-col widget-day-badge ${dayPercent == null ? "" : dayPercent >= 0 ? "up" : "down"}`}>
              <strong>{dayPercent == null ? "—" : signedPercent(dayPercent)}</strong>
            </div>
          </div>

          {/* 2. Current Stock Price + Total Gain/Loss */}
          <div className="widget-card-mid">
            <div className="price-col widget-price">
              <strong>{maybeMoney(holding.currentPrice, rowCurrency)}</strong>
            </div>
            <div className={`gain-col widget-total-gain ${gain == null ? "" : gain >= 0 ? "up" : "down"}`}>
              <span className="widget-gain-percent">
                <strong>{gainPercent == null ? "—" : signedPercent(gainPercent, 1)}</strong>
              </span>
              <small className="widget-gain-amount" aria-label={amountsVisible ? undefined : "金額非表示"}>
                {amountsVisible ? (gain == null ? "" : maybeSignedMoney(gain, rowCurrency)) : HIDDEN_AMOUNT}
              </small>
            </div>
          </div>

          {/* 3. Most Recent Price Fetched Time */}
          <div className="widget-card-bottom">
            <span
              className={`quote-dot ${quote?.freshness ?? "missing"}`}
              title={
                quote
                  ? `${quote.freshness === "near_live" ? "" : `${freshnessLabel[quote.freshness]} · `}${fetchedTime ? `${fetchedTime} 取得` : ""}`
                  : "価格未取得"
              }
            />
            <span className="widget-fetched-time">
              {fetchedTime ? `${fetchedTime} 取得` : "未取得"}
            </span>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={onSelect ? "selectable" : ""}
      onClick={() => onSelect?.(holding.securityId)}
      onKeyDown={(event) => {
        if (onSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(holding.securityId);
        }
      }}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `${secName}の詳細を開く` : undefined}
    >
      <td className="security-col">
        <strong title={secLegalName}>{secName}</strong>
        <span className="security-symbol">
          {secDisplaySymbol} · {marketDisplayName(sec)}
          {quote
            ? ` · ${marketTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency, stockCountry)}`
            : ""}
        </span>
      </td>
      <td className="price-col">
        <strong>{maybeMoney(holding.currentPrice, rowCurrency)}</strong>
      </td>
      <td className={`day-col ${day == null ? "" : day >= 0 ? "up" : "down"}`}>
        <strong>{dayPercent == null ? "—" : signedPercent(dayPercent)}</strong>
        <span aria-label={amountsVisible ? undefined : "金額非表示"}>{amountsVisible ? maybeSignedMoney(day, rowCurrency) : HIDDEN_AMOUNT}</span>
      </td>
      <td className="position-col">
        <strong aria-label={amountsVisible ? undefined : "保有数非表示"}>
          {amountsVisible ? `${number.format(Number(holding.quantity))}${securityQuantityUnit(sec, holding.securityId)}` : HIDDEN_AMOUNT}
        </strong>
        <span aria-label={amountsVisible ? undefined : "平均取得単価非表示"}>
          {amountsVisible
            ? `@ ${money(Number(holding.averageCost), rowCurrency)}${isFundSecurity(sec, holding.securityId) ? ` / ${securityPriceBasis(sec, holding.securityId)}` : ""}`
            : HIDDEN_AMOUNT}
        </span>
      </td>
      <td className="value-col">
        <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
          <span className="wide-number">{amountsVisible ? maybeMoney(holding.marketValue, rowCurrency) : HIDDEN_AMOUNT}</span>
          <span className="compact-number">
            {amountsVisible ? (holding.marketValue == null ? "—" : compactMoney(Number(holding.marketValue), rowCurrency)) : HIDDEN_AMOUNT}
          </span>
        </strong>
      </td>
      <td className="gain-col">
        <strong className={gain == null ? "" : gain >= 0 ? "up" : "down"}>{signedPercent(gainPercent, 1)}</strong>
      </td>
      <td className="weight-col">
        <strong>{totalValue != null && weightVal != null ? `${((Number(weightVal) / totalValue) * 100).toFixed(1)}%` : "—"}</strong>
        <span
          className={`quote-dot ${quote?.freshness ?? "missing"}`}
          title={
            quote
              ? `${quote.freshness === "near_live" ? "" : `${freshnessLabel[quote.freshness]} · `}${marketDateTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency)}（市場現地）`
              : "価格未取得"
          }
        />
      </td>
    </tr>
  );
});
