"use client";

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NAV_ITEMS } from "./constants";
import type { View } from "./types";

/** Main menu page shown last on this device; reopening the app returns to it. */
const LAST_VIEW_KEY = "kabutora-last-view-v1";

/** Views mounted (and then retained) during idle time after startup so switching paints instantly. */
const PRELOADED_VIEWS: View[] = ["overview", "watchlist", "activity", "dividends", "notifications", "settings"];
/** Warm-up waits this long after launch, and this long after the latest input. */
const WARM_UP_START_DELAY_MS = 2_000;
const WARM_UP_INPUT_QUIET_MS = 1_000;
const WARM_UP_INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "change"] as const;

/** The stored main menu page, if it is still a page in the menu. */
export function readLastView(storage: Storage): View {
  const stored = storage.getItem(LAST_VIEW_KEY);
  return NAV_ITEMS.find((item) => item.id === stored)?.id ?? "overview";
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Dashboard navigation: the active view, the set of retained (mounted) views, per-view
 * scroll restoration, and the security detail page with its return target.
 */
export function useViewNavigation(initialDetailSecurityId: string, storage: Storage) {
  const [view, setView] = useState<View>(() => readLastView(storage));
  const activeViewRef = useRef<View>(view);
  const [mountedViews, setMountedViews] = useState<Set<View>>(() => new Set<View>([view]));
  const viewScrollPositionsRef = useRef<Partial<Record<View, number>>>({});
  const [detailSecurityId, setDetailSecurityId] = useState(initialDetailSecurityId);
  const detailReturnViewRef = useRef<View>(view);
  const [detailReturnView, setDetailReturnView] = useState<View>(view);

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

  // Remember the menu page (the detail page reopens on the page it was opened from).
  useEffect(() => {
    storage.setItem(LAST_VIEW_KEY, view === "security" ? detailReturnView : view);
  }, [detailReturnView, storage, view]);

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

  // Warm the remaining views one per idle period, after the startup burst (cache hydration,
  // first prices, first calculation) and never right after input: a mount is a long render, so
  // it runs as an interruptible transition and waits for a quiet moment.
  useEffect(() => {
    const idleWindow = window as IdleWindow;
    const pending = PRELOADED_VIEWS.filter((target) => target !== activeViewRef.current);
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    let lastInputAt = performance.now();
    const recordInput = () => { lastInputAt = performance.now(); };
    for (const type of WARM_UP_INPUT_EVENTS) window.addEventListener(type, recordInput, { capture: true, passive: true });
    const scheduleNext = () => {
      if (cancelled || !pending.length) return;
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(warmNextView, { timeout: 1_500 });
      else timeoutId = window.setTimeout(warmNextView, 600);
    };
    const warmNextView = () => {
      if (cancelled) return;
      const quietFor = performance.now() - lastInputAt;
      if (quietFor < WARM_UP_INPUT_QUIET_MS) {
        timeoutId = window.setTimeout(scheduleNext, WARM_UP_INPUT_QUIET_MS - quietFor);
        return;
      }
      const nextView = pending.shift();
      if (!nextView) return;
      startTransition(() => mountView(nextView));
      scheduleNext();
    };
    timeoutId = window.setTimeout(scheduleNext, WARM_UP_START_DELAY_MS);
    return () => {
      cancelled = true;
      for (const type of WARM_UP_INPUT_EVENTS) window.removeEventListener(type, recordInput, { capture: true });
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [mountView]);

  return { view, activeViewRef, mountedViews, navigateToView, detailSecurityId, detailReturnView, detailReturnViewRef, showSecurity, closeSecurity };
}
