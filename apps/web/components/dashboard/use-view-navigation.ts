"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { View } from "./types";

/** Views mounted (and then retained) during idle time after startup so switching paints instantly. */
const IDLE_PRELOADED_VIEWS: View[] = ["watchlist", "activity", "dividends", "notifications", "settings"];

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Dashboard navigation: the active view, the set of retained (mounted) views, per-view
 * scroll restoration, and the security detail page with its return target.
 */
export function useViewNavigation(initialDetailSecurityId: string) {
  const [view, setView] = useState<View>("overview");
  const activeViewRef = useRef<View>(view);
  const [mountedViews, setMountedViews] = useState<Set<View>>(() => new Set<View>(["overview"]));
  const viewScrollPositionsRef = useRef<Partial<Record<View, number>>>({});
  const [detailSecurityId, setDetailSecurityId] = useState(initialDetailSecurityId);
  const detailReturnViewRef = useRef<View>("overview");
  const [detailReturnView, setDetailReturnView] = useState<View>("overview");

  const mountView = useCallback((target: View) => {
    setMountedViews((current) => {
      if (current.has(target)) return current;
      const next = new Set(current);
      next.add(target);
      return next;
    });
  }, []);

  const navigateToView = useCallback((target: View, restorePosition = true) => {
    const resolvedTarget = target === "performance" ? "overview" : target;
    if (resolvedTarget === activeViewRef.current) return;
    viewScrollPositionsRef.current[activeViewRef.current] = window.scrollY;
    if (!restorePosition) viewScrollPositionsRef.current[resolvedTarget] = 0;
    activeViewRef.current = resolvedTarget;
    mountView(resolvedTarget);
    setView(resolvedTarget);
  }, [mountView]);

  useEffect(() => { activeViewRef.current = view; }, [view]);

  useLayoutEffect(() => {
    window.scrollTo({ top: viewScrollPositionsRef.current[view] ?? 0, behavior: "auto" });
  }, [view]);

  /** Opens the detail page; `origin` overrides where "back" returns to. */
  const showSecurity = useCallback((securityId: string, origin?: View) => {
    const returnTarget = origin ?? (activeViewRef.current !== "security" ? activeViewRef.current : detailReturnViewRef.current);
    detailReturnViewRef.current = returnTarget;
    setDetailReturnView(returnTarget);
    setDetailSecurityId(securityId);
    navigateToView("security", false);
  }, [navigateToView]);

  const closeSecurity = useCallback(() => {
    navigateToView(detailReturnViewRef.current === "security" ? "overview" : detailReturnViewRef.current);
  }, [navigateToView]);

  // Warm the remaining views one per idle period.
  useEffect(() => {
    const idleWindow = window as IdleWindow;
    const pending = [...IDLE_PRELOADED_VIEWS];
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const scheduleNext = () => {
      if (cancelled || !pending.length) return;
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(warmNextView, { timeout: 1_500 });
      else timeoutId = window.setTimeout(warmNextView, 600);
    };
    const warmNextView = () => {
      if (cancelled) return;
      const nextView = pending.shift();
      if (!nextView) return;
      mountView(nextView);
      scheduleNext();
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [mountView]);

  return { view, activeViewRef, mountedViews, navigateToView, detailSecurityId, detailReturnView, detailReturnViewRef, showSecurity, closeSecurity };
}
