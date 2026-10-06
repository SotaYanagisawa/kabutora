"use client";
import { useBrowserPreferences } from "../app/browser-preferences";


import { useState, useMemo, useEffect, useCallback, memo } from "react";
import { marketDisplayName } from "@/lib/market/market-label";
import { Check, Pencil, Search, Trash2 } from "lucide-react";
import type { RemoteQuote, SearchSecurity, SecurityLookup } from "../dashboard/types";
import { marketTimeWithZoneLabel } from "@/lib/charts/market-time";
import WatchlistSearchOverlay from "./watchlist-search-overlay";

type WatchlistCategory = "ALL" | "JP" | "US" | "FUNDS_INDEXES";
type WatchlistSort = "DEFAULT" | "DAY_GAIN_DESC" | "DAY_GAIN_ASC" | "NAME_ASC" | "PRICE_DESC";

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });

const formatNativePrice = (value: number | string | null | undefined, currency: string) => {
  if (value == null) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2,
    }).format(num);
  } catch {
    return `${currency} ${numberFormat.format(num)}`;
  }
};

const signedPercent = (value: number | null, digits = 2) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
};

const isFundSecurity = (security: { assetType?: string; exchangeMic?: string } | null | undefined) =>
  security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND";

export type WatchlistViewProps = {
  watchlist: SearchSecurity[];
  onAddSecurity: (security: SearchSecurity) => void;
  onRemoveSecurity: (securityId: string) => void;
  securityMap: SecurityLookup;
  onSelectSecurity: (security: SearchSecurity | string) => void;
  allSecurities: SearchSecurity[];
};

const WatchlistTableRow = memo(function WatchlistTableRow({
  item,
  quote,
  isEditing,
  onSelectSecurity,
  onRemoveSecurity,
}: {
  item: SearchSecurity;
  quote?: RemoteQuote;
  isEditing: boolean;
  onSelectSecurity: (security: SearchSecurity | string) => void;
  onRemoveSecurity: (securityId: string) => void;
}) {
  const rawPrice = quote ? Number(quote.price) : null;
  const rawPrevious = quote?.previousRegularClose ? Number(quote.previousRegularClose) : null;
  const effectiveCurrency = item.currency;
  const dayDiff = rawPrice != null && rawPrevious != null ? rawPrice - rawPrevious : null;
  const dayPercent = rawPrice != null && rawPrevious ? rawPrice / rawPrevious - 1 : null;
  const stockMic = quote?.exchangeMic || item.exchangeMic;
  const stockTz = item.timezone;
  const stockCurrency = item.currency;
  const stockCountry = item.country;

  return (
    <tr
      key={item.id}
      className={`selectable ${isEditing ? "editing-row" : ""}`}
      onClick={() => {
        if (!isEditing) onSelectSecurity(item);
      }}
      role="row"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!isEditing && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelectSecurity(item);
        }
      }}
      aria-label={`${item.name}の詳細を開く`}
    >
      <td className="security-col">
        <strong title={item.name}>{item.name}</strong>
        <span className="security-symbol">
          {item.displaySymbol} · {marketDisplayName(item)}
          {quote ? ` · ${marketTimeWithZoneLabel(quote.marketTimestamp, stockMic, stockTz, stockCurrency, stockCountry)}` : ""}
        </span>
      </td>

      <td className="price-col">
        <strong>{rawPrice != null ? formatNativePrice(rawPrice, effectiveCurrency) : "—"}</strong>
      </td>

      <td className={`day-col ${dayDiff == null ? "" : dayDiff >= 0 ? "up" : "down"}`}>
        <strong>{signedPercent(dayPercent)}</strong>
        <span className={`day-diff-sub ${dayDiff == null ? "" : dayDiff >= 0 ? "up" : "down"}`}>
          {dayDiff != null
            ? `${dayDiff >= 0 ? "+" : ""}${formatNativePrice(dayDiff, effectiveCurrency)}`
            : "—"}
        </span>
      </td>

      <td className="market-col desktop-only-cell">
        <span className="market-badge">
          {item.assetType === "index"
            ? "指数"
            : item.assetType === "fund"
            ? "投信"
            : item.assetType === "etf"
            ? "ETF"
            : "株式"}
        </span>
        <span className="country-label">
          {item.country} · {item.currency}
        </span>
      </td>

      {/* Floating right-aligned trash button in edit mode */}
      {isEditing && (
        <button
          type="button"
          className="watchlist-floating-delete-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemoveSecurity(item.id);
          }}
          title="ウォッチリストから削除"
          aria-label={`${item.name}を削除`}
        >
          <Trash2 size={16} />
        </button>
      )}
    </tr>
  );
});

export default function WatchlistView({
  watchlist,
  onAddSecurity,
  onRemoveSecurity,
  securityMap,
  onSelectSecurity,
  allSecurities,
}: WatchlistViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<WatchlistCategory>("ALL");
  const preferenceStorage = useBrowserPreferences();
  const [sortBy, setSortBy] = useState<WatchlistSort>(() => {
    if (typeof window === "undefined") return "DEFAULT";
    try {
      const saved = preferenceStorage.getItem("kabutora-watchlist-sort") as WatchlistSort | null;
      if (saved && ["DEFAULT", "DAY_GAIN_DESC", "PRICE_DESC", "NAME_ASC"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "DEFAULT";
  });

  useEffect(() => {
    try {
      preferenceStorage.setItem("kabutora-watchlist-sort", sortBy);
    } catch {}
  }, [sortBy]);

  const [isSearchActive, setIsSearchActive] = useState(false);

  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);

  const exitSearch = useCallback(() => {
    setIsSearchActive(false);
  }, []);

  const filteredWatchlist = useMemo(() => {
    let items = watchlist.filter((item) => {
      if (selectedCategory === "ALL") return true;
      if (selectedCategory === "JP") return item.country === "JP" && item.assetType === "stock";
      if (selectedCategory === "US") return item.country === "US" && item.assetType === "stock";
      if (selectedCategory === "FUNDS_INDEXES") {
        return item.assetType === "fund" || item.assetType === "etf" || item.assetType === "index" || item.exchangeMic === "XIND" || isFundSecurity(item);
      }
      return true;
    });

    const resolveItemQuote = (id: string) => securityMap.get(id)?.quote;

    if (sortBy === "DAY_GAIN_DESC") {
      items = [...items].sort((a, b) => {
        const qA = resolveItemQuote(a.id);
        const qB = resolveItemQuote(b.id);
        const rA = qA && qA.previousRegularClose ? Number(qA.price) / Number(qA.previousRegularClose) - 1 : -Infinity;
        const rB = qB && qB.previousRegularClose ? Number(qB.price) / Number(qB.previousRegularClose) - 1 : -Infinity;
        return rB - rA;
      });
    } else if (sortBy === "DAY_GAIN_ASC") {
      items = [...items].sort((a, b) => {
        const qA = resolveItemQuote(a.id);
        const qB = resolveItemQuote(b.id);
        const rA = qA && qA.previousRegularClose ? Number(qA.price) / Number(qA.previousRegularClose) - 1 : Infinity;
        const rB = qB && qB.previousRegularClose ? Number(qB.price) / Number(qB.previousRegularClose) - 1 : Infinity;
        return rA - rB;
      });
    } else if (sortBy === "NAME_ASC") {
      items = [...items].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    } else if (sortBy === "PRICE_DESC") {
      items = [...items].sort((a, b) => {
        const qA = resolveItemQuote(a.id);
        const qB = resolveItemQuote(b.id);
        const pA = qA ? Number(qA.price) : -Infinity;
        const pB = qB ? Number(qB.price) : -Infinity;
        return pB - pA;
      });
    }

    return items;
  }, [securityMap, selectedCategory, sortBy, watchlist]);

  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="watchlist-page-container" role="region" aria-label="銘柄検索">
      <div
        className={`watchlist-view-content ${isSearchActive ? "is-search-covered" : ""}`}
        inert={isSearchActive || undefined}
        aria-hidden={isSearchActive || undefined}
      >
        {/* Main Watchlist View: Uses standardized HoldingsTable structure matching 一覧 page */}
        {filteredWatchlist.length === 0 ? (
          <div className="watchlist-empty-box">
            <div className="watchlist-empty-content">
              <Search size={26} className="empty-icon" />
              <p>
                {watchlist.length === 0
                  ? "ウォッチリストに登録されている銘柄はありません"
                  : "該当する銘柄がありません"}
              </p>
            </div>
          </div>
        ) : (
          <div className="holdings-table watchlist-holdings-table">
            <div className="holdings-mobile-header watchlist-mobile-header" role="row">
              <button
                type="button"
                className={`mobile-sort-btn ${sortBy === "NAME_ASC" ? "active" : ""}`}
                onClick={() => setSortBy(sortBy === "NAME_ASC" ? "DEFAULT" : "NAME_ASC")}
              >
                ウォッチリスト {sortBy === "NAME_ASC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
              </button>
              <button
                type="button"
                className={`mobile-sort-btn right ${sortBy === "PRICE_DESC" || sortBy === "DAY_GAIN_DESC" || sortBy === "DAY_GAIN_ASC" ? "active" : ""}`}
                onClick={() => {
                  if (sortBy === "PRICE_DESC") setSortBy("DAY_GAIN_DESC");
                  else if (sortBy === "DAY_GAIN_DESC") setSortBy("DAY_GAIN_ASC");
                  else setSortBy("PRICE_DESC");
                }}
              >
                {sortBy === "DAY_GAIN_DESC" ? "前日比 ↓" : sortBy === "DAY_GAIN_ASC" ? "前日比 ↑" : "現在値 / 前日比"}
              </button>
            </div>

            <table>
              <thead>
                <tr>
                  <th className={`sortable ${sortBy === "NAME_ASC" ? "active-sort" : ""}`} onClick={() => setSortBy(sortBy === "NAME_ASC" ? "DEFAULT" : "NAME_ASC")}>
                    ウォッチリスト {sortBy === "NAME_ASC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
                  </th>
                  <th className={`sortable ${sortBy === "PRICE_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy(sortBy === "PRICE_DESC" ? "DEFAULT" : "PRICE_DESC")}>
                    現在値 {sortBy === "PRICE_DESC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
                  </th>
                  <th className={`sortable ${sortBy === "DAY_GAIN_DESC" || sortBy === "DAY_GAIN_ASC" ? "active-sort" : ""}`} onClick={() => setSortBy(sortBy === "DAY_GAIN_DESC" ? "DAY_GAIN_ASC" : "DAY_GAIN_DESC")}>
                    前日比 {(sortBy === "DAY_GAIN_DESC" || sortBy === "DAY_GAIN_ASC") && <span className="sort-arrow active" aria-hidden="true">{sortBy === "DAY_GAIN_ASC" ? "↑" : "↓"}</span>}
                  </th>
                  <th style={{ textAlign: "center" }}>区分</th>
                </tr>
              </thead>
              <tbody>
                {filteredWatchlist.map((item) => {
                  return (
                    <WatchlistTableRow
                      key={item.id}
                      item={item}
                      quote={securityMap.get(item.id)?.quote}
                      isEditing={isEditing}
                      onSelectSecurity={onSelectSecurity}
                      onRemoveSecurity={onRemoveSecurity}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="watchlist-bottom-controls" data-swipe-ignore="true">
          <div className="segmented watchlist-tabs" role="tablist" aria-label="資産区分絞り込み">
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === "ALL"}
            className={selectedCategory === "ALL" ? "active" : ""}
            onClick={() => setSelectedCategory("ALL")}
          >
            すべて
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === "JP"}
            className={selectedCategory === "JP" ? "active" : ""}
            onClick={() => setSelectedCategory("JP")}
          >
            日本株
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === "US"}
            className={selectedCategory === "US" ? "active" : ""}
            onClick={() => setSelectedCategory("US")}
          >
            米国株
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === "FUNDS_INDEXES"}
            className={selectedCategory === "FUNDS_INDEXES" ? "active" : ""}
            onClick={() => setSelectedCategory("FUNDS_INDEXES")}
          >
            投信・指数
          </button>
          </div>

          <button
            type="button"
            className={`watchlist-edit-toggle-btn ${isEditing ? "active" : ""}`}
            onClick={() => setIsEditing((prev) => !prev)}
            aria-label={isEditing ? "編集を完了" : "ウォッチリストを編集"}
            title={isEditing ? "編集を完了" : "ウォッチリストを編集"}
          >
            {isEditing ? <Check size={20} /> : <Pencil size={20} />}
          </button>

          <button
            type="button"
            className="trade-button watchlist-search-btn"
            onClick={() => setIsSearchActive(true)}
            aria-label="銘柄を検索"
            title="銘柄を検索"
          >
            <Search size={20} />
          </button>
        </div>
      </div>

      {isSearchActive && (
        <WatchlistSearchOverlay
          securities={allSecurities}
          watchedIds={watchedIds}
          onAddSecurity={onAddSecurity}
          onRemoveSecurity={onRemoveSecurity}
          onSelectSecurity={onSelectSecurity}
          onClose={exitSearch}
        />
      )}
    </div>
  );
}
