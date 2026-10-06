import { memo, useMemo, useState } from "react";
import type { PortfolioNotification } from "@kabutora/domain/notifications";
import { Bell, Check, ChevronRight } from "lucide-react";
import { dateJa, money, number, signedPercent } from "./helpers";

export const notificationTypeLabel: Record<PortfolioNotification["type"], string> = {
  SPLIT: "株式分割",
  REVERSE_SPLIT: "株式併合",
  LIMIT_UP: "ストップ高",
  LIMIT_DOWN: "ストップ安",
  PRICE_UP: "急騰",
  PRICE_DOWN: "急落",
  TOB: "TOB",
  CORPORATE: "企業イベント",
};

export function NotificationRows({
  notifications,
  securityMap,
  readIds,
  onRead,
  onOpenSecurity,
  heldIds,
  compact = false,
}: {
  notifications: PortfolioNotification[];
  securityMap: Map<string, any>;
  readIds: Set<string>;
  onRead: (id: string) => void;
  onOpenSecurity?: (id: string) => void;
  heldIds?: Set<string>;
  compact?: boolean;
}) {
  if (!notifications.length) {
    return (
      <div className="notification-empty">
        <Bell size={20} />
        <span>該当する通知はありません</span>
      </div>
    );
  }

  return (
    <div className={`notification-rows ${compact ? "compact" : ""}`}>
      {notifications.map((notice) => {
        const security = notice.securityId ? securityMap.get(notice.securityId) : null;
        const isHeld = notice.securityId ? heldIds?.has(notice.securityId) : false;
        const isRead = readIds.has(notice.id);
        const unread = !isRead;
        const canOpen = Boolean(onOpenSecurity && notice.securityId);
        const isUp = notice.type === "PRICE_UP" || notice.type === "LIMIT_UP";
        const isDown = notice.type === "PRICE_DOWN" || notice.type === "LIMIT_DOWN";
        const toneClass = isUp ? "up" : isDown ? "down" : "";

        return (
          <article key={notice.id} className={`notification-row ${isRead ? "read" : "unread"}`}>
            <div className="notification-header-line">
              <div className="notification-type-badge">
                <span className={`notification-tag ${toneClass}`}>{notificationTypeLabel[notice.type] || notice.type}</span>
                {isHeld && <span className="notification-symbol-pill">保有</span>}
                <span className="notification-date">{dateJa(notice.occurredAt)}</span>
              </div>
              <div className="notification-status-indicator">
                {!isRead ? <span className="notification-unread-dot">未読</span> : <span className="notification-read-label">既読</span>}
              </div>
            </div>

            <div className="notification-main-content">
              <div className="notification-title-bar">
                <strong className="notification-title">{notice.title}</strong>
                {security?.displaySymbol && <span className="notification-symbol-pill">{security.displaySymbol}</span>}
              </div>
              <p className="notification-summary">{notice.summary}</p>
              {(notice.beforeQuantity != null ||
                (notice.beforeAverageCost != null && notice.afterAverageCost != null) ||
                (notice.beforeReferencePrice != null && notice.afterReferencePrice != null) ||
                notice.limitPrice != null ||
                notice.changeRatio != null ||
                notice.offerPrice != null) && (
                <div className="notification-facts-list">
                  {notice.beforeQuantity != null && (
                    <div className="notification-fact-chip">
                      <span>保有数:</span>
                      <strong>
                        {number.format(Number(notice.beforeQuantity))}株 → {number.format(Number(notice.afterQuantity))}株
                      </strong>
                    </div>
                  )}
                  {notice.beforeAverageCost != null && notice.afterAverageCost != null && (
                    <div className="notification-fact-chip">
                      <span>取得単価:</span>
                      <strong>
                        {money(Number(notice.beforeAverageCost), notice.currency)} → {money(Number(notice.afterAverageCost), notice.currency)}
                      </strong>
                    </div>
                  )}
                  {notice.beforeReferencePrice != null && notice.afterReferencePrice != null && (
                    <div className="notification-fact-chip">
                      <span>基準株価:</span>
                      <strong>
                        {money(Number(notice.beforeReferencePrice), notice.currency)} → {money(Number(notice.afterReferencePrice), notice.currency)}
                      </strong>
                    </div>
                  )}
                  {notice.limitPrice != null && (
                    <div className="notification-fact-chip">
                      <span>制限値段:</span>
                      <strong className={toneClass}>{money(Number(notice.limitPrice), notice.currency)}</strong>
                    </div>
                  )}
                  {notice.changeRatio != null && (
                    <div className="notification-fact-chip">
                      <span>騰落率:</span>
                      <strong className={toneClass}>{signedPercent(Number(notice.changeRatio))}</strong>
                    </div>
                  )}
                  {notice.offerPrice != null && (
                    <div className="notification-fact-chip">
                      <span>公開買付価格:</span>
                      <strong>{money(Number(notice.offerPrice), notice.currency)}</strong>
                    </div>
                  )}
                  {notice.expiresAt && (
                    <div className="notification-fact-chip">
                      <span>買付期限:</span>
                      <strong>{dateJa(notice.expiresAt)}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="notification-actions-footer">
              {unread && (
                <button type="button" className="notification-action-btn read-btn" onClick={() => onRead(notice.id)}>
                  既読にする
                </button>
              )}
              {canOpen && (
                <button
                  type="button"
                  className="notification-action-btn detail-btn"
                  onClick={() => {
                    onRead(notice.id);
                    onOpenSecurity?.(notice.securityId);
                  }}
                >
                  銘柄詳細
                  <ChevronRight size={13} />
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function NotificationsView({
  notifications,
  securityMap,
  detailSecurityIds,
  readNotificationIds,
  onRead,
  onReadAll,
  onOpenSecurity,
}: {
  notifications: PortfolioNotification[];
  securityMap: Map<string, any>;
  detailSecurityIds?: Set<string>;
  readNotificationIds: string[];
  onRead: (id: string) => void;
  onReadAll: (ids?: string[]) => void;
  onOpenSecurity?: (securityId: string) => void;
}) {
  const [filter, setFilter] = useState<"ALL" | "CORPORATE" | "PRICE">("ALL");
  const readIds = useMemo(() => new Set<string>(readNotificationIds), [readNotificationIds]);
  const priceTypes = new Set<PortfolioNotification["type"]>(["LIMIT_UP", "LIMIT_DOWN", "PRICE_UP", "PRICE_DOWN"]);
  const filtered = notifications.filter((notice: PortfolioNotification) =>
    filter === "ALL" ? true : filter === "PRICE" ? priceTypes.has(notice.type) : !priceTypes.has(notice.type),
  );
  const unread = notifications.filter((notice: PortfolioNotification) => !readIds.has(notice.id)).length;

  return (
    <div className="notification-page">
      <section className="notification-list panel">
        {filtered.length ? (
          <NotificationRows
            notifications={filtered}
            securityMap={securityMap}
            readIds={readIds}
            onRead={onRead}
            onOpenSecurity={onOpenSecurity}
            heldIds={detailSecurityIds}
          />
        ) : (
          <div className="notification-empty" role="status">
            <Bell size={24} />
            <strong>
              {filter === "PRICE"
                ? "値動き通知はありません"
                : filter === "CORPORATE"
                ? "企業イベントはありません"
                : "通知はありません"}
            </strong>
            <span>保有銘柄の株式分割・併合や急変動が発生した際に通知されます。</span>
          </div>
        )}
      </section>

      {/* Bottom Controls: Notification Filter Tabs & Mark All Read Button Dock in Single Row */}
      <div className="notification-bottom-controls" data-swipe-ignore="true">
        <div className="segmented notification-segmented" role="tablist" aria-label="通知種別">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "ALL"}
            className={filter === "ALL" ? "active" : ""}
            onClick={() => setFilter("ALL")}
          >
            すべて
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "CORPORATE"}
            className={filter === "CORPORATE" ? "active" : ""}
            onClick={() => setFilter("CORPORATE")}
          >
            企業イベント
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "PRICE"}
            className={filter === "PRICE" ? "active" : ""}
            onClick={() => setFilter("PRICE")}
          >
            値動き
          </button>
        </div>

        {unread > 0 && (
          <button
            className="secondary-button notification-read-all-btn"
            type="button"
            onClick={() => onReadAll(notifications.map((notice) => notice.id))}
            aria-label={`すべて既読にする (${unread}件)`}
            title={`すべて既読にする (${unread}件)`}
          >
            <Check size={16} />
            <span>既読 ({unread})</span>
          </button>
        )}
      </div>
    </div>
  );
}

export const FastNotificationsView = memo(NotificationsView);
