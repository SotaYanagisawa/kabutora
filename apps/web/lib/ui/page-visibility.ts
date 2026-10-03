import { useEffect } from "react";

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

/** Re-runs `tick` on an interval only while the page is visible. */
export function useVisibleInterval(tick: (() => void) | null, intervalMs: number, runOnVisible: boolean) {
  useEffect(() => {
    if (!tick) return;
    let timer: number | null = null;
    const stop = () => { if (timer != null) window.clearInterval(timer); timer = null; };
    const start = () => { stop(); timer = window.setInterval(tick, intervalMs); };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return stop();
      if (runOnVisible) tick();
      start();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [intervalMs, runOnVisible, tick]);
}
