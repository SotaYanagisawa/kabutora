import { useBrowserPreferences } from "../browser-preferences";
import { memo, useEffect, useMemo, useState } from "react";
import { canonicalDomainSecurityId, type IntradayBar, type MarketBar } from "@kabutora/domain";
import { companyDisplayName, shortSecurityDisplayName } from "@/lib/company-name";
import { marketDisplayName } from "@/lib/market-label";
import { isUsSecurity, type PortfolioFilter } from "@/lib/portfolio-filter";
import { freshnessLabel, HIDDEN_AMOUNT } from "./constants";
import {
  compactMoney,
  compactPrice,
  formatWidgetFetchedTime,
  isFundSecurity,
  maybeMoney,
  maybeSignedMoney,
  money,
  number,
  quoteTradeSourceLabel,
  securityPriceBasis,
  securityQuantityUnit,
  shortDateTimeJa,
  signedPercent,
} from "./helpers";
import type { DashboardHolding, DisplayCurrency, RemoteQuote } from "./types";

export type HoldingsViewMode = "grid";

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
    if (typeof window === "undefined") return "DAY_DESC";
    try {
      const saved = preferenceStorage.getItem("kabutora-holdings-sort") as HoldingsSort | null;
      if (saved && ["VALUE_DESC", "DAY_DESC", "GAIN_DESC", "DAY_GAIN_VALUE_DESC", "PRICE_DESC", "NAME_ASC"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "DAY_DESC";
  });

  useEffect(() => {
    try {
      preferenceStorage.setItem("kabutora-holdings-sort", sortBy);
    } catch {}
  }, [sortBy]);

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
    <div className={`holdings-table ${dense ? "dense" : ""} grid-view`}>
      <div className="holdings-header-bar" role="toolbar" aria-label="保有銘柄並び替え">
        <div className="holdings-sort-chips" role="group" aria-label="並び替え">
          <button
            type="button"
            className={`holdings-sort-chip ${sortBy === "DAY_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("DAY_DESC")}
          >
            前日比 {sortIndicator("DAY_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-sort-chip ${sortBy === "VALUE_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("VALUE_DESC")}
          >
            評価額 {sortIndicator("VALUE_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-sort-chip ${sortBy === "GAIN_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("GAIN_DESC")}
          >
            含み損益 {sortIndicator("GAIN_DESC")}
          </button>
          <button
            type="button"
            className={`holdings-sort-chip ${sortBy === "NAME_ASC" ? "active" : ""}`}
            onClick={() => setSortBy("NAME_ASC")}
          >
            銘柄 {sortIndicator("NAME_ASC")}
          </button>
          <button
            type="button"
            className={`holdings-sort-chip ${sortBy === "PRICE_DESC" ? "active" : ""}`}
            onClick={() => setSortBy("PRICE_DESC")}
          >
            現在値 {sortIndicator("PRICE_DESC")}
          </button>
        </div>
      </div>

      <table className="holdings-table-content is-grid">
        <tbody className="holdings-grid-body">
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
}) {
  const sec = holding.security;
  const isUs = isUsSecurity(sec, holding.securityId);
  const isFund = isFundSecurity(sec, holding.securityId);
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
  const secName = sec?.name || sec?.displaySymbol || holding.securityId;
  const secLegalName = sec?.legalName || secName;
  const secDisplaySymbol = sec?.displaySymbol || holding.securityId.replace(/^sec-(?:us-|jp-)?/i, "").toUpperCase();

  const primaryName = shortSecurityDisplayName({
    name: secName,
    brandName: sec?.brandName,
    shortName: sec?.shortName,
    displaySymbol: secDisplaySymbol,
    isUs,
    isFund,
  });

  const mktLabel = marketDisplayName(sec);
  const secondarySubtitle = isUs
    ? (companyDisplayName(sec) || secName)
    : isFund
    ? (secDisplaySymbol && !secDisplaySymbol.startsWith("fund-") && !secDisplaySymbol.startsWith("JP") ? secDisplaySymbol : "投資信託")
    : `${secDisplaySymbol}${mktLabel ? ` · ${mktLabel}` : ""}`;

  const fetchedTime = formatWidgetFetchedTime(
    quote?.fetchedAt,
    quote?.marketTimestamp,
    stockMic,
    stockTz,
    stockCurrency,
    sec?.country,
  );

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
        {/* Row 1: Primary Name (JP company short name / US ticker) + Fetched Time (top right) */}
        <div className="widget-card-row widget-row-header">
          <div className="security-col widget-ticker-wrap">
            <strong className="widget-ticker" title={secLegalName}>{primaryName}</strong>
          </div>
          <div
            className="widget-time-group"
            title={
              quote
                ? `${quote.freshness === "near_live" ? "" : `${freshnessLabel[quote.freshness]} · `}${fetchedTime ? `${quoteTradeSourceLabel(quote)} ${fetchedTime}` : ""}`
                : "価格未取得"
            }
          >
            <span className={`quote-dot ${quote?.freshness ?? "missing"}`} />
            <span className="widget-fetched-time">
              {fetchedTime ?? "未取得"}
            </span>
          </div>
        </div>

        {/* Row 2: Secondary line (JP: ticker/exchange, US: company name, Fund: type) */}
        <div className="widget-card-row widget-row-sub">
          <span className="widget-sec-name" title={secLegalName}>
            {secondarySubtitle}
          </span>
        </div>

        {/* Row 3: Current Stock Price (left, smaller) + Daily Change % (right, HERO metric, bold) */}
        <div className="widget-card-row widget-row-price">
          <div className="price-col widget-price">
            <strong title={maybeMoney(holding.currentPrice, rowCurrency)}>
              {compactPrice(holding.currentPrice, rowCurrency)}
            </strong>
          </div>
          <div className={`day-col widget-day-val ${day == null ? "" : day >= 0 ? "up" : "down"}`}>
            <strong>{dayPercent == null ? "—" : signedPercent(dayPercent)}</strong>
          </div>
        </div>

        {/* Row 4: Total Gain/Loss (return % + compact currency amount) */}
        <div className="widget-card-row widget-row-gain">
          <div className={`gain-col widget-total-gain ${gain == null ? "" : gain >= 0 ? "up" : "down"}`}>
            <div className="widget-gain-left">
              <span className="widget-gain-label">損益</span>
              <strong className="widget-gain-percent">
                {gainPercent == null ? "—" : signedPercent(gainPercent, 1)}
              </strong>
            </div>
            <small
              className="widget-gain-amount"
              aria-label={amountsVisible ? undefined : "金額非表示"}
              title={amountsVisible ? (gain == null ? undefined : maybeSignedMoney(gain, rowCurrency)) : undefined}
            >
              {amountsVisible ? (gain == null ? "" : compactMoney(Number(gain), rowCurrency, true)) : HIDDEN_AMOUNT}
            </small>
          </div>
        </div>
      </td>
    </tr>
  );
});
