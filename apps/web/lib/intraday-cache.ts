import type { IntradayBar } from "@kabutora/domain";

export const INTRADAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function sanitizeIntradayBars(bars: IntradayBar[]): IntradayBar[] {
  if (bars.length < 2) {
    return bars.filter((b) => Number.isFinite(Number(b.price)) && Number(b.price) > 0 && Number.isFinite(Date.parse(b.timestamp)));
  }

  const bySecurity = new Map<string, IntradayBar[]>();
  for (const bar of bars) {
    const p = Number(bar.price);
    const t = Date.parse(bar.timestamp);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t)) continue;
    const list = bySecurity.get(bar.securityId) ?? [];
    list.push(bar);
    bySecurity.set(bar.securityId, list);
  }

  const sanitized: IntradayBar[] = [];

  for (const [, secBars] of bySecurity) {
    const sorted = [...secBars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const n = sorted.length;
    if (n < 2) {
      sanitized.push(...sorted);
      continue;
    }

    const currentBars = sorted.map((b) => ({ ...b }));

    // Pass 1: Single-bar isolated anomalies (drops >= 30% or spikes >= 45%)
    for (let i = 1; i < n - 1; i += 1) {
      const prev = currentBars[i - 1];
      const curr = currentBars[i];
      const next = currentBars[i + 1];

      const pPrev = Number(prev.price);
      const pCurr = Number(curr.price);
      const pNext = Number(next.price);
      if (!Number.isFinite(pPrev) || !Number.isFinite(pCurr) || !Number.isFinite(pNext) || pPrev <= 0 || pNext <= 0) continue;

      const neighborRatio = pNext / pPrev;
      const neighborsConsistent = neighborRatio >= 0.5 && neighborRatio <= 2.0;
      const isIsolatedDip = neighborsConsistent && (pCurr / pPrev <= 0.70 && pCurr / pNext <= 0.70);
      const isIsolatedSpike = neighborsConsistent && (pCurr / pPrev >= 1.45 && pCurr / pNext >= 1.45);

      if (isIsolatedDip || isIsolatedSpike) {
        const tPrev = Date.parse(prev.timestamp);
        const tCurr = Date.parse(curr.timestamp);
        const tNext = Date.parse(next.timestamp);
        const alpha = tNext > tPrev ? Math.max(0, Math.min(1, (tCurr - tPrev) / (tNext - tPrev))) : 0.5;
        const pRepaired = pPrev + alpha * (pNext - pPrev);
        curr.price = String(Math.round(pRepaired * 10000) / 10000);
      }
    }

    // Pass 2: Two-bar consecutive isolated anomalies
    for (let i = 1; i < n - 2; i += 1) {
      const prev = currentBars[i - 1];
      const curr1 = currentBars[i];
      const curr2 = currentBars[i + 1];
      const next = currentBars[i + 2];

      const pPrev = Number(prev.price);
      const pCurr1 = Number(curr1.price);
      const pCurr2 = Number(curr2.price);
      const pNext = Number(next.price);
      if (!Number.isFinite(pPrev) || !Number.isFinite(pCurr1) || !Number.isFinite(pCurr2) || !Number.isFinite(pNext) || pPrev <= 0 || pNext <= 0) continue;

      const neighborRatio = pNext / pPrev;
      const neighborsConsistent = neighborRatio >= 0.5 && neighborRatio <= 2.0;
      const areBothDips = neighborsConsistent &&
        pCurr1 / pPrev <= 0.70 && pCurr1 / pNext <= 0.70 &&
        pCurr2 / pPrev <= 0.70 && pCurr2 / pNext <= 0.70;
      const areBothSpikes = neighborsConsistent &&
        pCurr1 / pPrev >= 1.45 && pCurr1 / pNext >= 1.45 &&
        pCurr2 / pPrev >= 1.45 && pCurr2 / pNext >= 1.45;

      if (areBothDips || areBothSpikes) {
        const tPrev = Date.parse(prev.timestamp);
        const tNext = Date.parse(next.timestamp);
        const span = tNext - tPrev;
        if (span > 0) {
          const alpha1 = Math.max(0, Math.min(1, (Date.parse(curr1.timestamp) - tPrev) / span));
          const alpha2 = Math.max(0, Math.min(1, (Date.parse(curr2.timestamp) - tPrev) / span));
          curr1.price = String(Math.round((pPrev + alpha1 * (pNext - pPrev)) * 10000) / 10000);
          curr2.price = String(Math.round((pPrev + alpha2 * (pNext - pPrev)) * 10000) / 10000);
        }
      }
    }

    // Pass 3: Edge anomalies (leading and trailing bars)
    if (n >= 2) {
      const last = currentBars[n - 1];
      const secondLast = currentBars[n - 2];
      const pLast = Number(last.price);
      const pSecondLast = Number(secondLast.price);
      if (Number.isFinite(pLast) && Number.isFinite(pSecondLast) && pSecondLast > 0) {
        const tailRatio = pLast / pSecondLast;
        if (tailRatio <= 0.65 || tailRatio >= 1.50) {
          last.price = secondLast.price;
        }
      }

      const first = currentBars[0];
      const second = currentBars[1];
      const pFirst = Number(first.price);
      const pSecond = Number(second.price);
      if (Number.isFinite(pFirst) && Number.isFinite(pSecond) && pSecond > 0) {
        const leadRatio = pFirst / pSecond;
        if (leadRatio <= 0.65 || leadRatio >= 1.50) {
          first.price = second.price;
        }
      }
    }

    sanitized.push(...currentBars);
  }

  return sanitized.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.securityId.localeCompare(b.securityId));
}

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
  const rawBars = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.securityId.localeCompare(b.securityId));
  return sanitizeIntradayBars(rawBars);
}
