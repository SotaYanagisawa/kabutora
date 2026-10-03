export type TouchAxis = "pending" | "horizontal" | "vertical";

export function resolveTouchAxis(deltaX: number, deltaY: number, lockDistance = 10): TouchAxis {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (Math.max(absX, absY) < lockDistance) return "pending";
  // Strict axis locking: horizontal swipes require deliberate horizontal motion (> 1.8x vertical)
  return absX > absY * 1.8 ? "horizontal" : "vertical";
}
export function swipeCommitDistance(viewportWidth: number) {
  return Math.min(120, Math.max(52, viewportWidth * 0.16));
}

export function shouldCommitSwipe(distance: number, velocity: number, viewportWidth: number, hasTarget: boolean) {
  if (!hasTarget) return false;
  return Math.abs(distance) >= swipeCommitDistance(viewportWidth)
    || (Math.abs(distance) >= 24 && Math.abs(velocity) >= 0.45);
}type ClosestTarget = { closest(selectors: string): Element | null };

function hasClosest(target: unknown): target is ClosestTarget {
  if (!target || typeof target !== "object" || !("closest" in target)) return false;
  return typeof (target as { closest?: unknown }).closest === "function";
}

export function isInteractiveInputTarget(target: unknown): boolean {
  if (!hasClosest(target)) return false;
  return Boolean(
    target.closest(
      "input, select, textarea, [contenteditable='true'], [role='slider'], .modal-layer, .date-range-layer"
    )
  );
}

export function isSwipeBlockedTarget(target: unknown): boolean {
  if (!hasClosest(target)) return false;
  return Boolean(
    target.closest(
      "input, select, textarea, [contenteditable='true'], [role='slider'], button, a, label, .modal-layer, .date-range-layer, .market-tape, .segmented, .mobile-nav, .mobile-control-dock, .desktop-nav, .watchlist-bottom-controls, nav, footer, [role='navigation'], svg, .lightweight-chart, .lightweight-donut, .daily-chart, .daily-performance, .detail-chart, .performance-chart, .allocation-chart-wrap, .allocation-view, .ticker-sparkline-wrap, .chart-tooltip, [data-chart], [data-swipe-ignore]"
    )
  );
}
