import type { MarketSessionStatus } from "@/lib/market/market-session";
import type { MarketStatus } from "./types";

export function MarketSessionIndicator({ sessions, quoteStatus }: { sessions: MarketSessionStatus[]; quoteStatus: MarketStatus }) {
  if (!sessions.length) {
    return (
      <span className="session-group" aria-label="日本・米国市場の取引セッション">
        {(["JP", "US"] as const).map((market) => (
          <small key={market} className="session-inline loading">
            <i className="session-dot" aria-hidden="true" />
            <span className="session-copy">
              <b className="session-market">{market}</b>{" "}
              <span className="session-status">{quoteStatus === "loading" ? "判定中" : "不明"}</span>
            </span>
          </small>
        ))}
      </span>
    );
  }
  return (
    <span className="session-group" aria-label="市場の取引セッション">
      {sessions.map((status) => {
        const compactLabel =
          status.session === "regular"
            ? "取引中"
            : status.session === "pre_market"
            ? "プレ"
            : status.session === "after_hours"
            ? "時間外"
            : status.session === "pts_day"
            ? "PTS日中"
            : status.session === "pts_night"
            ? "PTS夜間"
            : status.session === "closed"
            ? "休場"
            : "不明";
        const isOpen = Boolean(status.isOpen);
        return (
          <small
            key={status.market}
            className={`session-inline ${isOpen ? "open" : "closed"}`}
            title={`${status.marketLabel}: ${status.label} · ${status.detail} · カレンダー: ${status.calendarSource === "official" ? "取引所公表済み" : "取引所規則による推定"}`}
          >
            <i className="session-dot" aria-hidden="true" />
            <span className="session-copy">
              <b className="session-market">{status.market}</b>{" "}
              <span className="session-status">{compactLabel}</span>
            </span>
          </small>
        );
      })}
    </span>
  );
}
