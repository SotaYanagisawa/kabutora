import { useBrowserPreferences } from "../app/browser-preferences";
import { memo, useEffect, useMemo, useState } from "react";
import { companyDisplayName, shortSecurityDisplayName } from "@/lib/ui/company-name";
import { marketDisplayName } from "@/lib/market/market-label";
import { isUsSecurity } from "@/lib/portfolio/portfolio-filter";
import { exchangeTimeZone, marketDateTimeLabel } from "@/lib/charts/market-time";
import { freshnessLabel, HIDDEN_AMOUNT } from "./constants";
import {
  compactMoney,
  compactPrice,
  compactQuoteTime,
  compactSignedPercent,
  isFundSecurity,
  maybeMoney,
  maybeSignedMoney,
  quoteSessionLabel,
  quoteTradeSourceLabel,
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
  dense = false,
  onSelect,
  currency,
  amountsVisible = true,
}: {
  holdings: DashboardHolding[];
  dense?: boolean;
  onSelect?: (securityId: string) => void;
  currency: DisplayCurrency;
  amountsVisible?: boolean;
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
      const aVal = a.summaryMarketValue ?? a.marketValue ?? -Infinity;
      const bVal = b.summaryMarketValue ?? b.marketValue ?? -Infinity;

      const aPrice = a.price;
      const bPrice = b.price;
      const aDayPct = a.dayChangeRatio ?? -Infinity;
      const bDayPct = b.dayChangeRatio ?? -Infinity;
      const aDayGain = a.dayGain ?? -Infinity;
      const bDayGain = b.dayGain ?? -Infinity;
      const aGainPct = a.unrealizedGain != null && a.costBasis ? a.unrealizedGain / a.costBasis : -Infinity;
      const bGainPct = b.unrealizedGain != null && b.costBasis ? b.unrealizedGain / b.costBasis : -Infinity;

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
          {sortedHoldings.map((holding) => (
            <FastHoldingsTableRow key={holding.securityId} holding={holding} currency={currency} amountsVisible={amountsVisible} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FastHoldingsTableRow = memo(function FastHoldingsTableRow({
  holding,
  currency,
  amountsVisible,
  onSelect,
}: {
  holding: DashboardHolding;
  currency: DisplayCurrency;
  amountsVisible: boolean;
  onSelect?: (securityId: string) => void;
}) {
  const sec = holding.security;
  const isUs = isUsSecurity(sec, holding.securityId);
  const isFund = isFundSecurity(sec, holding.securityId);
  const rowCurrency = (currency === "NATIVE" ? holding.currency : currency) as DisplayCurrency;
  const quote = (sec?.quote ?? holding.quote) as RemoteQuote | undefined;
  const day = holding.dayGain;
  const dayPercent = holding.dayChangeRatio;
  const gain = holding.unrealizedGain;
  const gainPercent = gain != null && holding.costBasis ? gain / holding.costBasis : null;
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

  const timeZone = exchangeTimeZone(stockMic, stockTz, stockCurrency, sec?.country);
  const fetchedTime = compactQuoteTime(quote?.marketTimestamp ?? quote?.fetchedAt, timeZone);
  const sessionLabel = quote ? quoteSessionLabel(quote) : null;
  const extended = quote?.extendedChangeRatio;
  // The full source, date, time and zone (and the regular close an extended trade moved from) live in the title.
  const statusTitle = quote
    ? [
      `${quoteTradeSourceLabel(quote)} ${marketDateTimeLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency, sec?.country)}`,
      quote.regularPrice != null && quote.regularTimestamp
        ? `${quote.venueCode === "JNX" ? "東証終値" : quote.session === "pre_market" ? "前日終値" : "終値"} ${maybeMoney(quote.regularPrice, rowCurrency)}（${marketDateTimeLabel(quote.regularTimestamp, stockMic, stockTz, stockCurrency, sec?.country)}）`
        : "",
      quote.freshness === "near_live" ? "" : freshnessLabel[quote.freshness],
    ].filter(Boolean).join(" · ")
    : "価格未取得";

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
        {/* Left edge, top to bottom: name, code, price, day change, gain. Right edge: extended-hours move, time, gain amount. */}
        <div className="widget-card-row widget-row-header">
          <strong className="widget-ticker" title={secLegalName}>{primaryName}</strong>
        </div>

        {/* Code · market and the update time; during PTS / after-hours the session move replaces the time. */}
        <div className="widget-card-row widget-row-sub">
          <span className="widget-sec-name" title={secLegalName}>{extended != null && sessionLabel ? (isUs ? "" : secDisplaySymbol) : secondarySubtitle}</span>
          {extended != null && sessionLabel ? (
            <span className="widget-row-status extended" title={statusTitle}>
              <b className="widget-status-label">{sessionLabel}</b>
              <span className={`widget-status-change ${extended > 0 ? "up" : extended < 0 ? "down" : ""}`}>{signedPercent(extended)}</span>
            </span>
          ) : (
            <span className="widget-row-time" title={statusTitle}>
              <span className={`quote-dot ${quote?.freshness ?? "missing"}`} aria-hidden="true" />
              <span className="widget-fetched-time">{fetchedTime ?? "未取得"}</span>
            </span>
          )}
        </div>

        {/* The price has the whole card width to itself. */}
        <div className="widget-card-row widget-row-price">
          <div className="price-col widget-price">
            <strong title={maybeMoney(holding.price, rowCurrency)}>
              {compactPrice(holding.price, rowCurrency)}
            </strong>
          </div>
        </div>

        <div className={`widget-card-row widget-row-day day-col widget-day-val ${day == null ? "" : day >= 0 ? "up" : "down"}`}>
          <strong>{dayPercent == null ? "—" : signedPercent(dayPercent)}</strong>
        </div>

        <div className={`widget-card-row widget-row-gain gain-col widget-total-gain ${gain == null ? "" : gain >= 0 ? "up" : "down"}`}>
          <span className="widget-gain-left">
            <span className="widget-gain-label">損益</span>
            <strong className="widget-gain-percent">{compactSignedPercent(gainPercent)}</strong>
          </span>
          <small
            className="widget-gain-amount"
            aria-label={amountsVisible ? undefined : "金額非表示"}
            title={amountsVisible ? (gain == null ? undefined : maybeSignedMoney(gain, rowCurrency)) : undefined}
          >
            {amountsVisible ? (gain == null ? "" : compactMoney(gain, rowCurrency, true)) : HIDDEN_AMOUNT}
          </small>
        </div>
      </td>
    </tr>
  );
});
