"use client";

import { memo, useEffect, useRef, useState } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import { registerMarketSecurities } from "@/lib/market/market-client";
import { marketDisplayName } from "@/lib/market/market-label";
import type { SearchSecurity } from "../dashboard/types";
import { useSecuritySearch } from "./use-security-search";

export default memo(function SecuritySearchField({
  securities,
  selected,
  onSelect,
  onNetworkRequest,
  onQueryActiveChange,
}: {
  securities: SearchSecurity[];
  selected?: SearchSecurity;
  onSelect: (security: SearchSecurity) => void;
  onNetworkRequest?: () => void;
  onQueryActiveChange?: (active: boolean) => void;
}) {
  const {
    inputValue,
    inputQuery,
    results,
    status,
    setInputValue,
    beginComposition,
    finishComposition,
    clear,
  } = useSecuritySearch({
    securities,
    resultLimit: 8,
    onNetworkRequest,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const onQueryActiveChangeRef = useRef(onQueryActiveChange);
  onQueryActiveChangeRef.current = onQueryActiveChange;
  const lastActiveRef = useRef(false);

  useEffect(() => {
    const isActive = Boolean(inputValue.trim());
    if (lastActiveRef.current !== isActive) {
      lastActiveRef.current = isActive;
      onQueryActiveChangeRef.current?.(isActive);
    }
  }, [inputValue]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [inputQuery]);

  useEffect(() => {
    setSelectedIndex((current) => results.length ? Math.min(current, results.length - 1) : 0);
  }, [results.length]);

  const choose = (security: SearchSecurity) => {
    void registerMarketSecurities([security.id]).catch(()=>false);
    onSelect(security);
    clear();
    setSelectedIndex(0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      clear();
      setSelectedIndex(0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (results.length) choose(results[Math.min(selectedIndex, results.length - 1)]);
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((value) => (value + 1) % results.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((value) => (value - 1 + results.length) % results.length);
    }
  };

  const queryActive = Boolean(inputValue.trim());

  return (
    <div className="security-search-field">
      <label htmlFor="security-search">銘柄検索</label>
      <div className="security-search-input">
        <Search size={14} />
        <input
          id="security-search"
          role="combobox"
          aria-expanded={queryActive}
          aria-controls="security-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={queryActive && results.length ? `security-option-${selectedIndex}` : undefined}
          aria-busy={status === "loading"}
          autoComplete="off"
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onCompositionStart={beginComposition}
          onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="名前・コード・ティッカー"
        />
        {inputValue && (
          <button
            type="button"
            className="security-search-clear"
            aria-label="検索をクリア"
            onClick={() => {
              clear();
              setSelectedIndex(0);
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {selected && !queryActive && (
        <div className="selected-security" aria-live="polite">
          <i />
          <div>
            <strong>{selected.name}</strong>
            <span>{selected.displaySymbol} · {marketDisplayName(selected)} · {selected.currency}</span>
          </div>
          <small>選択中</small>
        </div>
      )}
      {queryActive && (
        <div className="security-suggestions" id="security-suggestions" role="listbox" aria-label="銘柄候補" aria-busy={status === "loading"}>
          {results.map((security, index) => (
            <button
              type="button"
              id={`security-option-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              key={security.id}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => choose(security)}
            >
              <div>
                <strong>{security.name}</strong>
                <span>{security.displaySymbol} · {security.exchangeLabel ?? security.exchangeMic} · {security.currency}</span>
              </div>
            </button>
          ))}
          {status === "loading" && !results.length && <div className="suggestion-state"><RefreshCw size={12} className="spin" />検索中</div>}
          {status === "error" && !results.length && <div className="suggestion-state">検索できませんでした</div>}
          {status === "ready" && !results.length && <div className="suggestion-state">一致する銘柄がありません</div>}
        </div>
      )}
    </div>
  );
});
