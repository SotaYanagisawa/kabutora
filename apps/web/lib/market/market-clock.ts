export type TrustedMarketClockAnchor = { serverMs: number; monotonicMs: number };

export function trustedMarketClockAnchor(serverMs: number, monotonicMs: number): TrustedMarketClockAnchor | null {
  return Number.isFinite(serverMs) && Number.isFinite(monotonicMs) ? { serverMs, monotonicMs } : null;
}

export function resolveMarketClock(
  anchor: TrustedMarketClockAnchor | null,
  monotonicNow: number,
  deviceNow: number,
) {
  if (anchor && Number.isFinite(anchor.serverMs) && Number.isFinite(anchor.monotonicMs) && Number.isFinite(monotonicNow)) {
    return anchor.serverMs + Math.max(0, monotonicNow - anchor.monotonicMs);
  }
  return Number.isFinite(deviceNow) ? deviceNow : null;
}
