"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, RefreshCw, Search, X } from "lucide-react";
import { registerMarketSecurities } from "@/lib/market/market-client";
import { marketDisplayName } from "@/lib/market/market-label";
import type { SearchSecurity } from "../dashboard/types";
import { useSecuritySearch } from "../search/use-security-search";

export default memo(function WatchlistSearchOverlay({
  securities,
  watchedIds,
  onAddSecurity,
  onRemoveSecurity,
  onSelectSecurity,
  onClose,
}: {
  securities: readonly SearchSecurity[];
  watchedIds: ReadonlySet<string>;
  onAddSecurity: (security: SearchSecurity) => void;
  onRemoveSecurity: (securityId: string) => void;
  onSelectSecurity: (security: SearchSecurity) => void;
  onClose: () => void;
}) {
  const {
    inputValue,
    inputQuery,
    query,
    results,
    status,
    remotePending,
    setInputValue,
    beginComposition,
    finishComposition,
    clear,
  } = useSecuritySearch({ securities, resultLimit: 15 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingSubmitQueryRef = useRef<string | null>(null);

  const choose = useCallback((security: SearchSecurity) => {
    pendingSubmitQueryRef.current = null;
    onClose();
    void registerMarketSecurities([security.id]).catch(()=>false);
    onSelectSecurity(security);
  }, [onClose, onSelectSecurity]);

  useEffect(() => {
    const focusInput = () => inputRef.current?.focus({ preventScroll: true });
    focusInput();
    const animationFrame = requestAnimationFrame(focusInput);
    const timer = window.setTimeout(focusInput, 50);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    pendingSubmitQueryRef.current = null;
    setSelectedIndex(0);
  }, [inputQuery]);

  useEffect(() => {
    setSelectedIndex((current) => results.length ? Math.min(current, results.length - 1) : 0);
  }, [results.length]);

  useEffect(() => {
    const pendingQuery = pendingSubmitQueryRef.current;
    if (!pendingQuery || pendingQuery !== query || results.length === 0) return;
    pendingSubmitQueryRef.current = null;
    choose(results[0]);
  }, [choose, query, results]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (inputValue) {
        clear();
        setSelectedIndex(0);
        pendingSubmitQueryRef.current = null;
      } else {
        onClose();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      if (!results.length) return;
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      if (!results.length) return;
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + results.length) % results.length);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const selected = results[Math.min(selectedIndex, Math.max(0, results.length - 1))];
    if (selected) {
      choose(selected);
    } else if (inputQuery && (remotePending || status === "idle" || status === "loading")) {
      pendingSubmitQueryRef.current = inputQuery;
    }
  };

  const toggleWatchlist = (event: React.MouseEvent, security: SearchSecurity) => {
    event.preventDefault();
    event.stopPropagation();
    if (watchedIds.has(security.id)) onRemoveSecurity(security.id);
    else { void registerMarketSecurities([security.id]).catch(()=>false); onAddSecurity(security); }
  };

  const queryActive = Boolean(inputValue.trim());
  return (
    <>
      <div
        className="watchlist-search-backdrop"
        onClick={onClose}
        data-swipe-ignore="true"
        aria-hidden="true"
      />
      <section
        className="watchlist-top-search-pane"
        role="dialog"
        aria-modal="true"
        aria-label="銘柄検索"
        data-swipe-ignore="true"
      >
        <div className="watchlist-top-search-header">
          <div className="watchlist-top-input-wrap">
            <Search size={16} className="watchlist-top-search-icon" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              name="search_securities_query"
              id="watchlist-search-active"
              role="combobox"
              aria-expanded={queryActive}
              aria-controls="watchlist-search-results"
              aria-autocomplete="list"
              aria-activedescendant={queryActive && results.length ? `watchlist-search-option-${selectedIndex}` : undefined}
              aria-busy={status === "loading"}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onCompositionStart={beginComposition}
              onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="銘柄名・ティッカー・投信を検索"
              className="watchlist-top-search-input"
            />
            {inputValue && (
              <button
                type="button"
                className="watchlist-top-clear-btn"
                aria-label="検索をクリア"
                onClick={() => {
                  clear();
                  setSelectedIndex(0);
                  pendingSubmitQueryRef.current = null;
                  inputRef.current?.focus({ preventScroll: true });
                }}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <button type="button" className="watchlist-top-cancel-btn" onClick={onClose}>
            キャンセル
          </button>
        </div>

        {queryActive && (
          <div
            className="watchlist-top-results-container"
            id="watchlist-search-results"
            role="listbox"
            aria-label="銘柄候補"
            data-swipe-ignore="true"
          >
            {results.map((result, index) => {
              const isAdded = watchedIds.has(result.id);
              return (
                <div
                  key={result.id}
                  id={`watchlist-search-option-${index}`}
                  className={`search-dropdown-item top-result-item ${index === selectedIndex ? "focused" : ""}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <button
                    type="button"
                    className="search-item-main"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => choose(result)}
                  >
                    <span className="search-item-name">{result.name}</span>
                    <span className="search-item-meta">
                      {result.displaySymbol} · {marketDisplayName(result)} · {result.currency}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`search-item-toggle ${isAdded ? "is-added" : ""}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={(event) => toggleWatchlist(event, result)}
                    aria-label={isAdded ? `${result.name}を削除` : `${result.name}を追加`}
                  >
                    {isAdded ? (
                      <><Check size={13} /> <span>登録済</span></>
                    ) : (
                      <><Plus size={13} /> <span>追加</span></>
                    )}
                  </button>
                </div>
              );
            })}
            {status === "loading" && !results.length && (
              <div className="search-dropdown-status">
                <RefreshCw size={14} className="spin" /> 検索中…
              </div>
            )}
            {status === "error" && !results.length && (
              <div className="search-dropdown-status">検索できませんでした</div>
            )}
            {status === "ready" && !results.length && (
              <div className="search-dropdown-status">一致する銘柄が見つかりませんでした</div>
            )}
          </div>
        )}
      </section>
    </>
  );
});
