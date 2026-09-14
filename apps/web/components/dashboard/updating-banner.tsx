"use client";

import { memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, RefreshCw } from "lucide-react";
import type { MarketStatus } from "./types";
import {
  isActivelyUpdating,
  resolveUpdatingMessage,
  type UpdatingPhase,
} from "@/lib/updating-status";

export interface UpdatingBannerProps {
  isManualRefreshing: boolean;
  quoteStatus: MarketStatus;
  historyStatus: MarketStatus;
  distributionStatus: MarketStatus;
  benchmarkStatus: MarketStatus;
  historyBarsCount?: number;
  quotesCount?: number;
}

export const UpdatingBanner = memo(function UpdatingBanner({
  isManualRefreshing,
  quoteStatus,
  historyStatus,
  distributionStatus,
  benchmarkStatus,
  historyBarsCount = 0,
  quotesCount = 0,
}: UpdatingBannerProps) {
  const options = {
    isManualRefreshing,
    quoteStatus,
    historyStatus,
    distributionStatus,
    benchmarkStatus,
  };

  // Background quote/history refreshes should not interrupt navigation. The
  // same status component still reports an explicit user-requested refresh.
  const isUpdating = isManualRefreshing && isActivelyUpdating(options);
  const currentMessage = resolveUpdatingMessage(options);

  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<UpdatingPhase>("updating");
  const [message, setMessage] = useState(currentMessage);

  const wasUpdatingRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isUpdating) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      wasUpdatingRef.current = true;
      setPhase("updating");
      setMessage(currentMessage);
      setVisible(true);
    } else if (wasUpdatingRef.current) {
      wasUpdatingRef.current = false;
      const isFailed =
        (historyStatus === "error" && historyBarsCount === 0) ||
        (quoteStatus === "error" && quotesCount === 0);

      if (isFailed) {
        setPhase("error");
        setMessage("一部データの取得に失敗しました");
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, 2200);
      } else {
        setPhase("done");
        setMessage("更新完了");
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, 950);
      }
    }
  }, [isUpdating, currentMessage, historyStatus, quoteStatus, historyBarsCount, quotesCount]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <aside
      className="updating-banner"
      data-visible={visible ? "true" : "false"}
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="updating-pill">
        {phase === "updating" && (
          <RefreshCw size={12} className="spin" aria-hidden="true" />
        )}
        {phase === "done" && (
          <Check size={12} className="check-icon" aria-hidden="true" />
        )}
        {phase === "error" && (
          <AlertCircle size={12} className="error-icon" aria-hidden="true" />
        )}
        <span className="updating-text">{message}</span>
      </div>
    </aside>
  );
});
