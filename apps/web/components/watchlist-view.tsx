"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { IntradayBar, MarketBar } from "@kabutora/domain";
import type { MarketSessionStatus } from "@/lib/market-session";
import { searchMarketSecurities } from "@/lib/market-search-client";
import { marketDisplayName } from "@/lib/market-label";
import { searchKnownJapanFunds } from "@/lib/japan-fund-catalog";
import {
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { DisplayCurrency, RemoteQuote, SearchSecurity, MarketStatus } from "./dashboard";
import { marketDateKey, marketTimeLabel, sparseIntradayTimeTicks } from "@/lib/chart-presentation";

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

const money = (value: number, currency = "JPY") =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2,
  }).format(value);

const isFundSecurity = (security: { assetType?: string; exchangeMic?: string } | null | undefined) =>
  security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND";

export type WatchlistViewProps = {
  watchlist: SearchSecurity[];
  onAddSecurity: (security: SearchSecurity) => void;
  onRemoveSecurity: (securityId: string) => void;
  quotes: Record<string, RemoteQuote>;
  intradayBySecurity: Map<string, IntradayBar[]>;
  dailyHistoryBySecurity: Map<string, MarketBar[]>;
  quoteStatus: MarketStatus;
  marketSessions: MarketSessionStatus[];
  currency: DisplayCurrency;
  currentUsdJpy: number | null;
  onSelectSecurity: (security: SearchSecurity | string) => void;
  onOpenTrade?: (security: SearchSecurity) => void;
  onRefresh: () => void;
  amountsVisible: boolean;
  allSecurities: SearchSecurity[];
};

export default function WatchlistView({
  watchlist,
  onAddSecurity,
  onRemoveSecurity,
  quotes,
  intradayBySecurity,
  dailyHistoryBySecurity,
  quoteStatus,
  currency,
  currentUsdJpy,
  onSelectSecurity,
  onOpenTrade,
  onRefresh,
  allSecurities,
}: WatchlistViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchSecurity[]>([]);
  const [searchStatus, setSearchStatus] = useState<MarketStatus>("idle");
  const [selectedCategory, setSelectedCategory] = useState<WatchlistCategory>("ALL");
  const [sortBy, setSortBy] = useState<WatchlistSort>(() => {
    if (typeof window === "undefined") return "DEFAULT";
    try {
      const saved = localStorage.getItem("kabutora-watchlist-sort") as WatchlistSort | null;
      if (saved && ["DEFAULT", "DAY_GAIN_DESC", "PRICE_DESC", "NAME_ASC"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "DEFAULT";
  });

  useEffect(() => {
    try {
      localStorage.setItem("kabutora-watchlist-sort", sortBy);
    } catch {}
  }, [sortBy]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeSearchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const pendingSubmitRef = useRef(false);

  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);

  const exitSearch = useCallback(() => {
    setIsSearchActive(false);
    setIsSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    searchInputRef.current?.blur();
    activeSearchInputRef.current?.blur();
  }, []);

  useEffect(() => {
    if (isSearchActive) {
      const focusInput = () => {
        if (activeSearchInputRef.current) {
          activeSearchInputRef.current.focus({ preventScroll: true });
        }
      };
      focusInput();
      const rafId = requestAnimationFrame(focusInput);
      const timer = setTimeout(focusInput, 50);
      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(timer);
      };
    }
  }, [isSearchActive]);

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    return () => document.removeEventListener("mousedown", handleDocumentClick);
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    pendingSubmitRef.current = false;
    if (query.length < 1) {
      setSearchResults([]);
      setSearchStatus("idle");
      setIsSearchOpen(false);
      return;
    }

    setSearchStatus("loading");
    setIsSearchOpen(true);

    const localCatalog = searchKnownJapanFunds(query);
    const localMatches = allSecurities.filter((item) => {
      const q = query.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.displaySymbol.toLowerCase().includes(q) ||
        (item.providerSymbols?.yahoo && item.providerSymbols.yahoo.toLowerCase().includes(q))
      );
    });

    const initialCombined = [...new Map([...localCatalog, ...localMatches].map((item) => [item.id, item])).values()];
    if (initialCombined.length > 0) {
      setSearchResults(initialCombined.slice(0, 8));
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMarketSecurities<SearchSecurity>(query)
        .then((remote) => {
          if (cancelled) return;
          const combined = [...new Map([...localCatalog, ...remote, ...localMatches].map((item) => [item.id, item])).values()];
          setSearchResults(combined.slice(0, 15));
          setSearchStatus("ready");

          if (pendingSubmitRef.current && combined.length > 0) {
            pendingSubmitRef.current = false;
            setIsSearchOpen(false);
            onSelectSecurity(combined[0]);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (!initialCombined.length) {
            setSearchResults([]);
            setSearchStatus("error");
          } else {
            setSearchStatus("ready");
            if (pendingSubmitRef.current && initialCombined.length > 0) {
              pendingSubmitRef.current = false;
              setIsSearchOpen(false);
              onSelectSecurity(initialCombined[0]);
            }
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allSecurities, onSelectSecurity, searchQuery]);

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

    if (sortBy === "DAY_GAIN_DESC") {
      items = [...items].sort((a, b) => {
        const qA = quotes[a.id];
        const qB = quotes[b.id];
        const rA = qA && qA.previousRegularClose ? Number(qA.price) / Number(qA.previousRegularClose) - 1 : -Infinity;
        const rB = qB && qB.previousRegularClose ? Number(qB.price) / Number(qB.previousRegularClose) - 1 : -Infinity;
        return rB - rA;
      });
    } else if (sortBy === "DAY_GAIN_ASC") {
      items = [...items].sort((a, b) => {
        const qA = quotes[a.id];
        const qB = quotes[b.id];
        const rA = qA && qA.previousRegularClose ? Number(qA.price) / Number(qA.previousRegularClose) - 1 : Infinity;
        const rB = qB && qB.previousRegularClose ? Number(qB.price) / Number(qB.previousRegularClose) - 1 : Infinity;
        return rA - rB;
      });
    } else if (sortBy === "NAME_ASC") {
      items = [...items].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    } else if (sortBy === "PRICE_DESC") {
      items = [...items].sort((a, b) => {
        const pA = quotes[a.id] ? Number(quotes[a.id].price) : -Infinity;
        const pB = quotes[b.id] ? Number(quotes[b.id].price) : -Infinity;
        return pB - pA;
      });
    }

    return items;
  }, [quotes, selectedCategory, sortBy, watchlist]);

  const stats = useMemo(() => {
    let upCount = 0;
    let downCount = 0;
    let totalCount = watchlist.length;

    for (const item of watchlist) {
      const quote = quotes[item.id];
      if (quote && quote.previousRegularClose) {
        const diff = Number(quote.price) - Number(quote.previousRegularClose);
        if (diff > 0) upCount += 1;
        else if (diff < 0) downCount += 1;
      }
    }

    return { totalCount, upCount, downCount };
  }, [quotes, watchlist]);

  const [isEditing, setIsEditing] = useState(false);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (searchResults.length ? (prev + 1) % searchResults.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => (searchResults.length ? (prev - 1 + searchResults.length) % searchResults.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (searchResults.length === 1) {
        onSelectSecurity(searchResults[0]);
      } else if (searchResults.length > 0 && searchResults[selectedIndex]) {
        const item = searchResults[selectedIndex];
        onSelectSecurity(item);
      } else if (searchStatus === "loading") {
        pendingSubmitRef.current = true;
      }
    }
  };

  const handleToggleWatchlist = useCallback((e: React.MouseEvent, item: SearchSecurity) => {
    e.preventDefault();
    e.stopPropagation();
    if (watchedIds.has(item.id)) {
      onRemoveSecurity(item.id);
    } else {
      onAddSecurity(item);
    }
  }, [onAddSecurity, onRemoveSecurity, watchedIds]);

  return (
    <div className="watchlist-page-container" role="region" aria-label="銘柄検索">
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
          {/* Mobile Table Header matching 一覧 page */}
          <div className="holdings-mobile-header watchlist-mobile-header" role="row">
            <button
              type="button"
              className={`mobile-sort-btn ${sortBy === "NAME_ASC" ? "active" : ""}`}
              onClick={() => setSortBy(sortBy === "NAME_ASC" ? "DEFAULT" : "NAME_ASC")}
            >
              ウォッチリスト {sortBy === "NAME_ASC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
            </button>
            <span className="mobile-header-label">推移</span>
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

          {/* Table matching 一覧 page layout */}
          <table>
            <thead>
              <tr>
                <th
                  className={`sortable ${sortBy === "NAME_ASC" ? "active-sort" : ""}`}
                  onClick={() => setSortBy(sortBy === "NAME_ASC" ? "DEFAULT" : "NAME_ASC")}
                >
                  ウォッチリスト {sortBy === "NAME_ASC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
                </th>
                <th style={{ textAlign: "center" }}>推移</th>
                <th
                  className={`sortable ${sortBy === "PRICE_DESC" ? "active-sort" : ""}`}
                  onClick={() => setSortBy(sortBy === "PRICE_DESC" ? "DEFAULT" : "PRICE_DESC")}
                >
                  現在値 {sortBy === "PRICE_DESC" && <span className="sort-arrow active" aria-hidden="true">↓</span>}
                </th>
                <th
                  className={`sortable ${sortBy === "DAY_GAIN_DESC" || sortBy === "DAY_GAIN_ASC" ? "active-sort" : ""}`}
                  onClick={() => setSortBy(sortBy === "DAY_GAIN_DESC" ? "DAY_GAIN_ASC" : "DAY_GAIN_DESC")}
                >
                  前日比 {(sortBy === "DAY_GAIN_DESC" || sortBy === "DAY_GAIN_ASC") && <span className="sort-arrow active" aria-hidden="true">{sortBy === "DAY_GAIN_ASC" ? "↑" : "↓"}</span>}
                </th>
                <th style={{ textAlign: "center" }}>区分</th>
              </tr>
            </thead>
            <tbody>
              {filteredWatchlist.map((item) => {
                const quote = quotes[item.id];
                const rawPrice = quote ? Number(quote.price) : null;
                const rawPrevious = quote?.previousRegularClose ? Number(quote.previousRegularClose) : null;
                const effectiveCurrency = item.currency;
                const dayDiff = rawPrice != null && rawPrevious != null ? rawPrice - rawPrevious : null;
                const dayPercent = rawPrice != null && rawPrevious ? rawPrice / rawPrevious - 1 : null;
                const intraday = intradayBySecurity.get(item.id) ?? [];
                const dailyHistory = dailyHistoryBySecurity.get(item.id) ?? [];
                const isFund = isFundSecurity(item);

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
                        {quote ? ` · ${marketTimeLabel(quote.marketTimestamp, item.exchangeMic, item.timezone, item.currency)}` : ""}
                      </span>
                    </td>

                    <td className="sparkline-col">
                      {isFund ? (
                        <DailyFundSparkline
                          bars={dailyHistory.length >= 2 ? dailyHistory : intraday.map((bar) => ({
                            securityId: bar.securityId,
                            date: bar.timestamp.slice(0, 10),
                            close: bar.price,
                            provider: bar.provider,
                          }))}
                          currency={effectiveCurrency as DisplayCurrency}
                        />
                      ) : (
                        <IntradaySparkline
                          bars={intraday}
                          previousClose={rawPrevious}
                          positive={dayDiff != null ? dayDiff >= 0 : true}
                          currency={effectiveCurrency as DisplayCurrency}
                          exchangeMic={item.exchangeMic}
                          timeZone={item.timezone}
                          stockCurrency={item.currency}
                        />
                      )}
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
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Full Backdrop for Search Mode (tapping anywhere outside exits search mode) */}
      {isSearchActive && (
        <div
          className="watchlist-search-backdrop"
          onClick={exitSearch}
          data-swipe-ignore="true"
        />
      )}

      {/* Top-Shifted Search Header & Results (when active) */}
      {isSearchActive && (
        <div className="watchlist-top-search-pane" data-swipe-ignore="true">
          <div className="watchlist-top-search-header">
            <div className="watchlist-top-input-wrap">
              <Search size={16} className="watchlist-top-search-icon" />
              <input
                ref={activeSearchInputRef}
                autoFocus
                type="text"
                inputMode="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                name="search_securities_query"
                id="watchlist-search-active"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchResults[selectedIndex]) {
                    e.preventDefault();
                    onSelectSecurity(searchResults[selectedIndex]);
                  } else {
                    handleSearchKeyDown(e);
                  }
                }}
                placeholder="銘柄名・ティッカー・投信を検索"
                className="watchlist-top-search-input"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="watchlist-top-clear-btn"
                  aria-label="検索をクリア"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                    activeSearchInputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="watchlist-top-cancel-btn"
              onClick={exitSearch}
            >
              キャンセル
            </button>
          </div>

          {/* Search Results followed directly below the top search bar */}
          {searchQuery.trim().length > 0 && (
            <div
              className="watchlist-top-results-container"
              role="listbox"
              data-swipe-ignore="true"
            >
              {searchResults.map((result, idx) => {
                const isAdded = watchedIds.has(result.id);
                return (
                  <div
                    key={result.id}
                    className={`search-dropdown-item top-result-item ${idx === selectedIndex ? "focused" : ""}`}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <button
                      type="button"
                      className="search-item-main"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        onSelectSecurity(result);
                      }}
                    >
                      <span className="search-item-name">{result.name}</span>
                      <span className="search-item-meta">
                        {result.displaySymbol} · {marketDisplayName(result)} · {result.currency}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`search-item-toggle ${isAdded ? "is-added" : ""}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => handleToggleWatchlist(e, result)}
                      aria-label={isAdded ? `${result.name}を削除` : `${result.name}を追加`}
                    >
                      {isAdded ? (
                        <>
                          <Check size={13} /> <span>登録済</span>
                        </>
                      ) : (
                        <>
                          <Plus size={13} /> <span>追加</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
              {searchStatus === "loading" && (
                <div className="search-dropdown-status">
                  <RefreshCw size={14} className="spin" /> 検索中…
                </div>
              )}
              {searchStatus === "ready" && !searchResults.length && (
                <div className="search-dropdown-status">一致する銘柄が見つかりませんでした</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom Controls: Filter Tabs & Search Trigger in Single Row */}
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
          onClick={() => {
            setIsSearchActive(true);
            activeSearchInputRef.current?.focus({ preventScroll: true });
          }}
          aria-label="銘柄を検索"
          title="銘柄を検索"
        >
          <Search size={20} />
        </button>
      </div>
    </div>
  );
}

function DailyFundSparkline({ bars, currency }: { bars: MarketBar[]; currency: DisplayCurrency }) {
  const orderedBars = [...bars]
    .filter((bar) => Number.isFinite(Number(bar.close)))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = orderedBars.at(-1)?.date.slice(0, 10);
  const cutoff = latestDate ? new Date(`${latestDate}T00:00:00Z`) : null;
  cutoff?.setUTCMonth(cutoff.getUTCMonth() - 1);
  const recentBars = cutoff
    ? orderedBars.filter((bar) => new Date(`${bar.date.slice(0, 10)}T00:00:00Z`) >= cutoff)
    : [];
  const selectedBars = recentBars.length >= 2 ? recentBars : orderedBars.slice(-30);
  const shortDate = (date: string) => {
    const [, month, day] = date.slice(0, 10).split("-");
    return month && day ? `${Number(month)}/${Number(day)}` : "—";
  };
  if (selectedBars.length < 2)
    return (
      <span className="ticker-sparkline-wrap fund-daily-empty">
        <svg className="ticker-sparkline empty" viewBox="0 0 120 44" role="img" aria-label="日次基準価額の履歴なし">
          <path d="M2 22H118" />
        </svg>
        <span className="sparkline-times" aria-hidden="true">
          <span>日次更新</span>
        </span>
      </span>
    );
  const values = selectedBars.map((bar) => Number(bar.close));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.05, rawMax * 0.0005);
  const min = rawMin - padding;
  const spread = rawMax + padding - min || 1;
  const y = (value: number) => 40 - ((value - min) / spread) * 36;
  const points = values.map((value, index) => `${2 + (index / (values.length - 1)) * 116},${y(value)}`).join(" ");
  const positive = values.at(-1)! >= values[0];
  return (
    <span className="ticker-sparkline-wrap fund-daily-sparkline">
      <svg
        className={`ticker-sparkline ${positive ? "positive" : "negative"}`}
        viewBox="0 0 120 44"
        preserveAspectRatio="none"
        role="img"
        aria-label={`基準価額1か月推移、${shortDate(selectedBars[0].date)}から${shortDate(selectedBars.at(-1)!.date)}、最新 ${money(values.at(-1)!, currency)}`}
      >
        <g className="spark-grid">
          <line x1="2" y1="3" x2="118" y2="3" />
          <line x1="2" y1="22" x2="118" y2="22" />
          <line x1="2" y1="41" x2="118" y2="41" />
        </g>
        <polyline points={points} />
      </svg>
      <span className="sparkline-times" aria-hidden="true">
        <time>{shortDate(selectedBars[0].date)}</time>
        <span>1M・日次</span>
        <time>{shortDate(selectedBars.at(-1)!.date)}</time>
      </span>
    </span>
  );
}

function IntradaySparkline({
  bars,
  previousClose,
  positive,
  currency,
  exchangeMic,
  timeZone,
  stockCurrency,
}: {
  bars: IntradayBar[];
  previousClose: number | null;
  positive: boolean;
  currency: DisplayCurrency;
  exchangeMic: string;
  timeZone?: string;
  stockCurrency?: string;
}) {
  const orderedBars = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latestDate = orderedBars.map((bar) => marketDateKey(bar.timestamp, exchangeMic, timeZone, stockCurrency)).filter(Boolean).at(-1);
  const currentSessionBars = latestDate ? orderedBars.filter((bar) => marketDateKey(bar.timestamp, exchangeMic, timeZone, stockCurrency) === latestDate) : [];
  const selectedBars = currentSessionBars.length >= 2 ? currentSessionBars : orderedBars.slice(-30);
  if (selectedBars.length < 2)
    return (
      <span className="ticker-sparkline-wrap">
        <svg className="ticker-sparkline empty" viewBox="0 0 120 44" role="img" aria-label="日中価格データなし">
          <path d="M2 22H118" />
        </svg>
      </span>
    );
  const values = selectedBars.map((bar) => Number(bar.price));
  const scaleValues = previousClose == null ? values : [...values, previousClose];
  const rawMin = Math.min(...scaleValues);
  const rawMax = Math.max(...scaleValues);
  const padding = Math.max((rawMax - rawMin) * 0.05, rawMax * 0.0005);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const spread = max - min || 1;
  const y = (value: number) => 40 - ((value - min) / spread) * 36;
  const points = values.map((value, index) => `${2 + (index / (values.length - 1)) * 116},${y(value)}`).join(" ");
  const previousY = previousClose == null ? null : y(previousClose);
  const timeTicks = sparseIntradayTimeTicks(selectedBars);
  const timeLabel = (timestamp: string) => marketTimeLabel(timestamp, exchangeMic, timeZone, stockCurrency);
  return (
    <span className="ticker-sparkline-wrap">
      <svg
        className={`ticker-sparkline ${positive ? "positive" : "negative"}`}
        viewBox="0 0 120 44"
        preserveAspectRatio="none"
        role="img"
        aria-label={`日中価格 ${money(values.at(-1) ?? 0, currency)}、市場現地時間${timeLabel(timeTicks[0])}から${timeLabel(timeTicks.at(-1)!)}、前日終値 ${previousClose == null ? "不明" : money(previousClose, currency)}`}
      >
        <g className="spark-grid">
          <line x1="2" y1="3" x2="118" y2="3" />
          <line x1="2" y1="22" x2="118" y2="22" />
          <line x1="2" y1="41" x2="118" y2="41" />
        </g>
        {previousY != null && <line className="previous-close" x1="2" y1={previousY} x2="118" y2={previousY} />}
        <polyline points={points} />
      </svg>
      <span className="sparkline-times" aria-hidden="true">
        {timeTicks.map((timestamp) => (
          <time key={timestamp}>{timeLabel(timestamp)}</time>
        ))}
      </span>
    </span>
  );
}
