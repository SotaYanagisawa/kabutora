import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Returns whether the document is currently visible to the user.
 * In SSR / non-browser environments, defaults to true.
 */
export function isDocumentVisible(doc?: Document): boolean {
  const targetDoc = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!targetDoc) return true;
  return targetDoc.visibilityState === "visible";
}

/**
 * Subscribes to document visibility changes.
 * Calls `callback(isVisible)` immediately with current state and on every `visibilitychange`.
 * Returns an unsubscribe cleanup function.
 */
export function onVisibilityChange(
  callback: (visible: boolean) => void,
  doc?: Document,
): () => void {
  const targetDoc = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!targetDoc) return () => {};

  const listener = () => {
    callback(targetDoc.visibilityState === "visible");
  };

  targetDoc.addEventListener("visibilitychange", listener);
  return () => {
    targetDoc.removeEventListener("visibilitychange", listener);
  };
}

export function subscribeVisibility(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", callback);
  return () => {
    document.removeEventListener("visibilitychange", callback);
  };
}

export function getVisibilitySnapshot(): boolean {
  return typeof document !== "undefined" ? document.visibilityState === "visible" : true;
}

export function getVisibilityServerSnapshot(): boolean {
  return true;
}

/**
 * React hook returning current visibility state.
 * Uses useSyncExternalStore for tear-free, concurrent-safe updates.
 */
export function usePageVisibility(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilityServerSnapshot,
  );
}

export type VisibilityLoopController = {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  destroy: () => void;
};

/**
 * Creates a visibility-aware requestAnimationFrame loop.
 * Automatically halts requestAnimationFrame execution when document.visibilityState === 'hidden'
 * and resumes drawing once visibilitychange fires 'visible'.
 */
export function createVisibilityAwareLoop(
  renderCallback: (timestamp: number) => void,
  win: Window = window,
  doc: Document = document,
): VisibilityLoopController {
  let frameId: number | null = null;
  let active = false;
  let destroyed = false;

  const tick = (timestamp: number) => {
    if (!active || destroyed) return;
    if (doc.visibilityState === "hidden") {
      frameId = null;
      return;
    }
    renderCallback(timestamp);
    frameId = win.requestAnimationFrame(tick);
  };

  const resumeIfNeeded = () => {
    if (!active || destroyed) return;
    if (doc.visibilityState === "visible" && frameId == null) {
      frameId = win.requestAnimationFrame(tick);
    } else if (doc.visibilityState === "hidden" && frameId != null) {
      win.cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  doc.addEventListener("visibilitychange", resumeIfNeeded);

  return {
    start: () => {
      if (destroyed || active) return;
      active = true;
      if (doc.visibilityState === "visible" && frameId == null) {
        frameId = win.requestAnimationFrame(tick);
      }
    },
    stop: () => {
      active = false;
      if (frameId != null) {
        win.cancelAnimationFrame(frameId);
        frameId = null;
      }
    },
    isRunning: () => active && frameId != null,
    destroy: () => {
      destroyed = true;
      active = false;
      if (frameId != null) {
        win.cancelAnimationFrame(frameId);
        frameId = null;
      }
      doc.removeEventListener("visibilitychange", resumeIfNeeded);
    },
  };
}

/**
 * React hook to drive a canvas render loop or animation frame loop.
 * Automatically suspends requestAnimationFrame execution when the document is hidden
 * and resumes drawing once visibilitychange fires 'visible'.
 */
export function useVisibilityAwareCanvasLoop(
  renderCallback: (timestamp: number) => void,
  enabled: boolean = true,
): void {
  const callbackRef = useRef(renderCallback);
  callbackRef.current = renderCallback;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") return;
    const controller = createVisibilityAwareLoop((ts) => callbackRef.current(ts), window, document);
    controller.start();
    return () => {
      controller.destroy();
    };
  }, [enabled]);
}

/**
 * Synchronizes document.documentElement.dataset.pageVisibility with document.visibilityState.
 * Allows CSS rules (e.g. `html[data-page-visibility="hidden"] .market-tape-track`) to pause
 * hardware-accelerated animations automatically on inactive tabs.
 */
export function syncPageVisibilityDataset(doc?: Document): () => void {
  const targetDoc = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!targetDoc?.documentElement) return () => {};

  const update = () => {
    targetDoc.documentElement.dataset.pageVisibility = targetDoc.visibilityState;
  };

  update();
  targetDoc.addEventListener("visibilitychange", update);
  return () => {
    targetDoc.removeEventListener("visibilitychange", update);
  };
}
