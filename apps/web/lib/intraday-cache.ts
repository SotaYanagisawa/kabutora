import type { IntradayBar } from "@kabutora/domain";

export const INTRADAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function mergeIntradayBars(existing: IntradayBar[], incoming: IntradayBar[], now = Date.now(), retentionMs = INTRADAY_RETENTION_MS) {
  const cutoff = now - retentionMs;
  const merged = new Map<string, IntradayBar>();
  for (const bar of [...existing, ...incoming]) {
    const timestamp = new Date(bar.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
    merged.set(`${bar.securityId}\u0000${bar.timestamp}`, bar);
  }
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.securityId.localeCompare(b.securityId));
}
