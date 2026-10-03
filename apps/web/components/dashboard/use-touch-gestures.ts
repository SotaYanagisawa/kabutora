"use client";

import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { isInteractiveInputTarget, isSwipeBlockedTarget, resolveTouchAxis, shouldCommitSwipe } from "@/lib/ui/touch-navigation";
import { MOBILE_LAYOUT_QUERY, MOBILE_TOUCH_NAVIGATION_ORDER, MOBILE_VIEW_INDEX, PULL_REFRESH_MAX, PULL_REFRESH_THRESHOLD, TOUCH_NAVIGATION_LOCK_PX } from "./constants";
import type { TouchGesture, View } from "./types";

const PULL_EASING = "cubic-bezier(0.18, 0.9, 0.32, 1)";

type Options = {
  view: View;
  navigateToView: (target: View) => void;
  closeSecurity: () => void;
  refreshMarket: () => Promise<void>;
  isManualRefreshing: boolean;
};

/**
 * Mobile shell gestures: horizontal swipe between main views (or back from a detail page),
 * pull-to-refresh by touch or trackpad wheel, and keyboard-aware viewport sizing.
 * Pull visuals are written directly to the DOM so dragging never re-renders React.
 */
export function useTouchGestures({ view, navigateToView, closeSecurity, refreshMarket, isManualRefreshing }: Options) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const touchGesture = useRef<TouchGesture | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const pullDistanceRef = useRef(0);

  /** Pull distance is shown by translating the workspace; written to the DOM to avoid re-renders. */
  const updatePullVisuals = useCallback((distance: number, isRefreshing: boolean, animated: boolean) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const offset = isRefreshing ? 0 : distance;
    workspace.style.transition = animated ? `transform 0.28s ${PULL_EASING}` : "none";
    workspace.style.transform = offset > 0 ? `translate3d(0, ${offset}px, 0)` : "";
  }, []);

  const pullRefresh = useCallback(() => {
    pullDistanceRef.current = 0;
    updatePullVisuals(0, true, true);
    setIsPullRefreshing(true);
    void refreshMarket().finally(() => {
      setIsPullRefreshing(false);
      updatePullVisuals(0, false, true);
    });
  }, [refreshMarket, updatePullVisuals]);

  // Size the shell to the visual viewport while the mobile keyboard is open.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    let frame: number | null = null;
    const syncViewport = () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const shell = appShellRef.current;
        if (!shell) return;
        const isKeyboard = window.matchMedia(MOBILE_LAYOUT_QUERY).matches && visualViewport ? visualViewport.height < window.innerHeight - 80 : false;
        if (isKeyboard && visualViewport) {
          const viewportTop = Math.floor(visualViewport.offsetTop ?? 0);
          const viewportBottom = Math.ceil((visualViewport.offsetTop ?? 0) + visualViewport.height);
          shell.style.setProperty("--app-viewport-height", `${viewportBottom - viewportTop}px`);
          shell.style.setProperty("--app-viewport-top", `${viewportTop}px`);
        } else {
          shell.style.removeProperty("--app-viewport-height");
          shell.style.removeProperty("--app-viewport-top");
        }
      });
    };
    syncViewport();
    visualViewport?.addEventListener("resize", syncViewport, { passive: true });
    visualViewport?.addEventListener("scroll", syncViewport, { passive: true });
    window.addEventListener("resize", syncViewport, { passive: true });
    window.addEventListener("orientationchange", syncViewport, { passive: true });
    return () => {
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    const target = event.target;
    const compact = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
    const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    if (event.touches.length !== 1 || !touch || isInteractiveInputTarget(target) || (!compact && currentScrollY > 0)) {
      touchGesture.current = null;
      return;
    }
    touchGesture.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastAt: performance.now(),
      velocityX: 0,
      distanceX: 0,
      axis: "pending",
      currentIndex: MOBILE_VIEW_INDEX[view] ?? 2,
      pullEnabled: view !== "security" && !isPullRefreshing && currentScrollY <= 2,
      swipeBlocked: isSwipeBlockedTarget(target),
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    const gesture = touchGesture.current;
    const touch = event.touches[0];
    if (!gesture || !touch || event.touches.length !== 1) return;
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    if (gesture.axis === "pending") {
      const axis = resolveTouchAxis(deltaX, deltaY, TOUCH_NAVIGATION_LOCK_PX);
      if (axis === "horizontal") gesture.axis = gesture.swipeBlocked ? "cancelled" : "horizontal";
      else if (axis === "vertical") gesture.axis = gesture.pullEnabled && deltaY > 0 ? "vertical" : "cancelled";
    }
    if (gesture.axis === "cancelled" || gesture.axis === "pending") return;
    if (gesture.axis === "horizontal") {
      if (event.cancelable) event.preventDefault();
      const time = performance.now();
      const instantaneousVelocity = (touch.clientX - gesture.lastX) / Math.max(1, time - gesture.lastAt);
      gesture.velocityX = gesture.velocityX * 0.55 + instantaneousVelocity * 0.45;
      gesture.lastX = touch.clientX;
      gesture.lastAt = time;
      gesture.distanceX = deltaX;
      return;
    }
    if ((window.scrollY || document.documentElement.scrollTop || 0) > 2) {
      gesture.axis = "cancelled";
      pullDistanceRef.current = 0;
      updatePullVisuals(0, false, false);
      return;
    }
    if (deltaY > 0 && event.cancelable) event.preventDefault();
    pullDistanceRef.current = deltaY > 0 ? Math.min(PULL_REFRESH_MAX, Math.pow(deltaY, 0.82) * 1.6) : 0;
    updatePullVisuals(pullDistanceRef.current, false, false);
  };

  const finishTouchGesture = (cancelled: boolean) => {
    const gesture = touchGesture.current;
    const shouldRefresh = gesture?.axis === "vertical" && pullDistanceRef.current >= PULL_REFRESH_THRESHOLD;
    const releaseVelocity = gesture && performance.now() - gesture.lastAt <= 90 ? gesture.velocityX : 0;
    touchGesture.current = null;
    pullDistanceRef.current = 0;
    if (gesture?.axis === "horizontal") {
      if (view === "security") {
        if (!cancelled && gesture.distanceX > 0 && (gesture.distanceX >= 45 || (gesture.distanceX >= 20 && Math.abs(releaseVelocity) >= 0.3))) closeSecurity();
        return;
      }
      const direction = gesture.distanceX < 0 ? 1 : -1;
      const nextView = MOBILE_TOUCH_NAVIGATION_ORDER[gesture.currentIndex + direction];
      if (!cancelled && nextView && shouldCommitSwipe(Math.abs(gesture.distanceX), Math.abs(releaseVelocity), window.innerWidth, true)) navigateToView(nextView);
    }
    if (!cancelled && shouldRefresh) pullRefresh();
    else updatePullVisuals(0, false, true);
  };

  // Trackpad/mouse wheel overscroll at the top acts as pull-to-refresh on desktop.
  useEffect(() => {
    let wheelAccumulator = 0;
    let wheelDecayTimer: ReturnType<typeof setTimeout> | null = null;
    const handleWheel = (event: WheelEvent) => {
      if (window.scrollY > 0 || isManualRefreshing || isPullRefreshing || view === "security") return;
      if (event.deltaY >= 0 || event.ctrlKey) return;
      wheelAccumulator += Math.abs(event.deltaY) * 0.45;
      const clamped = Math.min(PULL_REFRESH_MAX, wheelAccumulator);
      if (clamped > 3) {
        pullDistanceRef.current = clamped;
        updatePullVisuals(clamped, false, false);
      }
      if (wheelDecayTimer) clearTimeout(wheelDecayTimer);
      wheelDecayTimer = setTimeout(() => {
        if (pullDistanceRef.current >= PULL_REFRESH_THRESHOLD) pullRefresh();
        else {
          pullDistanceRef.current = 0;
          updatePullVisuals(0, false, true);
        }
        wheelAccumulator = 0;
      }, 140);
    };
    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (wheelDecayTimer) clearTimeout(wheelDecayTimer);
    };
  }, [isManualRefreshing, isPullRefreshing, pullRefresh, updatePullVisuals, view]);

  return {
    appShellRef, workspaceRef,
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd: () => finishTouchGesture(false), onTouchCancel: () => finishTouchGesture(true) },
  };
}
