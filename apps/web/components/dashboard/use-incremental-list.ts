"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Live `matchMedia` result; `false` during server rendering. */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((notify: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", notify);
    return () => list.removeEventListener("change", notify);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/**
 * Renders a long list in pages: `count` rows at first, then another page whenever the sentinel
 * scrolls within `margin` of the viewport. Keeps the DOM small for ledgers with thousands of rows.
 * The count never shrinks: rows are rebuilt on every price poll, and a reset would pull a reader
 * who scrolled deep into the list back to the first page.
 */
export function useIncrementalList(total: number, page = 120, margin = "1200px") {
  const [count, setCount] = useState(page);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore = count < total;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!hasMore || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setCount((current) => Math.min(total, current + page));
    }, { rootMargin: `${margin} 0px` });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, margin, page, total, count]);
  return { visible: Math.min(count, total), hasMore, sentinelRef, showAll: () => setCount(total) };
}
