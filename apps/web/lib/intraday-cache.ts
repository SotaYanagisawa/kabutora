import type { IntradayBar } from "@kabutora/domain";

export const INTRADAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function mergeIntradayBars(existing: IntradayBar[], incoming: IntradayBar[], now = Date.now(), retentionMs = INTRADAY_RETENTION_MS) {
  const cutoff = now - retentionMs;
  const merged = new Map<string, IntradayBar>();
  for (const bar of [...existing, ...incoming]) {
    const timestamp = new Date(bar.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
    const minute = bar.timestamp.slice(0, 16);
    const key = `${bar.securityId}\u0000${minute}`;
    const current = merged.get(key);
    const isPts = bar.session === "pts_day" || bar.session === "pts_night";
    const currentIsPts = current?.session === "pts_day" || current?.session === "pts_night";
    if (current && !currentIsPts && isPts) continue;
    merged.set(key, bar);
  }
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.securityId.localeCompare(b.securityId));
}
