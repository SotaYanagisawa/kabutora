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

    // Helper: multi-tier isolated anomaly detection for single bar
    const isSingleBarAnomaly = (pPrev: number, pCurr: number, pNext: number) => {
      const neighborRatio = pNext / pPrev;
      const ratioPrev = pCurr / pPrev;
      const ratioNext = pCurr / pNext;

      // Tier 1: Very tight neighbors (within 6%), aberrant single print (>= 3.5% deviation)
      if (neighborRatio >= 0.94 && neighborRatio <= 1.06) {
        if (ratioPrev <= 0.965 && ratioNext <= 0.965) return true;
        if (ratioPrev >= 1.035 && ratioNext >= 1.035) return true;
      }

      // Tier 2: Moderate neighbors (within 15%), large print error (>= 10% deviation)
      if (neighborRatio >= 0.85 && neighborRatio <= 1.18) {
        if (ratioPrev <= 0.90 && ratioNext <= 0.90) return true;
        if (ratioPrev >= 1.10 && ratioNext >= 1.10) return true;
      }

      // Tier 3: Loose neighbors (within 2x), extreme glitch (>= 25% dip / >= 35% spike)
      if (neighborRatio >= 0.50 && neighborRatio <= 2.00) {
        if (ratioPrev <= 0.75 && ratioNext <= 0.75) return true;
        if (ratioPrev >= 1.35 && ratioNext >= 1.35) return true;
      }

      return false;
    };

    // Helper: multi-tier isolated anomaly detection for two consecutive bars
    const areTwoBarAnomalies = (pPrev: number, pCurr1: number, pCurr2: number, pNext: number) => {
      const neighborRatio = pNext / pPrev;
      const r1Prev = pCurr1 / pPrev;
      const r1Next = pCurr1 / pNext;
      const r2Prev = pCurr2 / pPrev;
      const r2Next = pCurr2 / pNext;

      // Tier 1: Tight neighbors (within 6%), >= 3.5% deviation
      if (neighborRatio >= 0.94 && neighborRatio <= 1.06) {
        const bothDips = r1Prev <= 0.965 && r1Next <= 0.965 && r2Prev <= 0.965 && r2Next <= 0.965;
        const bothSpikes = r1Prev >= 1.035 && r1Next >= 1.035 && r2Prev >= 1.035 && r2Next >= 1.035;
        if (bothDips || bothSpikes) return true;
      }

      // Tier 2: Moderate neighbors (within 15%), >= 10% deviation
      if (neighborRatio >= 0.85 && neighborRatio <= 1.18) {
        const bothDips = r1Prev <= 0.90 && r1Next <= 0.90 && r2Prev <= 0.90 && r2Next <= 0.90;
        const bothSpikes = r1Prev >= 1.10 && r1Next >= 1.10 && r2Prev >= 1.10 && r2Next >= 1.10;
        if (bothDips || bothSpikes) return true;
      }

      // Tier 3: Loose neighbors (within 2x), >= 25% dip / >= 35% spike
      if (neighborRatio >= 0.50 && neighborRatio <= 2.00) {
        const bothDips = r1Prev <= 0.75 && r1Next <= 0.75 && r2Prev <= 0.75 && r2Next <= 0.75;
        const bothSpikes = r1Prev >= 1.35 && r1Next >= 1.35 && r2Prev >= 1.35 && r2Next >= 1.35;
        if (bothDips || bothSpikes) return true;
      }

      return false;
    };

    // Pass 1: Single-bar isolated anomalies
    for (let i = 1; i < n - 1; i += 1) {
      const prev = currentBars[i - 1];
      const curr = currentBars[i];
      const next = currentBars[i + 1];

      const pPrev = Number(prev.price);
      const pCurr = Number(curr.price);
      const pNext = Number(next.price);
      if (!Number.isFinite(pPrev) || !Number.isFinite(pCurr) || !Number.isFinite(pNext) || pPrev <= 0 || pNext <= 0) continue;

      if (isSingleBarAnomaly(pPrev, pCurr, pNext)) {
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

      if (areTwoBarAnomalies(pPrev, pCurr1, pCurr2, pNext)) {
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
        if (tailRatio <= 0.70 || tailRatio >= 1.45) {
          last.price = secondLast.price;
        }
      }

      const first = currentBars[0];
      const second = currentBars[1];
      const pFirst = Number(first.price);
      const pSecond = Number(second.price);
      if (Number.isFinite(pFirst) && Number.isFinite(pSecond) && pSecond > 0) {
        const leadRatio = pFirst / pSecond;
        if (leadRatio <= 0.70 || leadRatio >= 1.45) {
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
