import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { portfolioFilterLabel, type PortfolioFilter } from "@/lib/portfolio-filter";
import { DEFAULT_PRICE_ALERT_PERCENT, PRICE_ALERT_THRESHOLDS } from "@/lib/portfolio-notifications";
import type { HistoryQuality } from "@/lib/market-history";
import { Download, LogOut, ShieldCheck } from "lucide-react";
import { ACCENT_THEMES, APP_RELEASE_DATE, APP_VERSION, UPDATE_FREQUENCIES } from "./constants";
import { CLIENT_BUILD_ID } from "@/lib/client-recovery";
import { benchmarkNumber, shortDateTimeJa, timeJa } from "./helpers";
import type {
  AccentTheme,
  DataSecurityAction,
  DisplayCurrency,
  FetchHealth,
  HistoryCacheMeta,
  MarketStatus,
  Seed,
  UpdateFrequency,
} from "./types";

export function SettingsView({
  seed,
  exportCsv,
  exportJson,
  onEncryptedBackup,
  onRestoreBackup,
  allowPlaintextExport,
  onLock,
  onLogout,
  dark,
  setDark,
  accentTheme,
  setAccentTheme,
  quoteStatus,
  benchmarkStatus,
  historyStatus,
  historyQuality,
  historyCacheMeta,
  quoteHealth,
  historyHealth,
  dataReconciled,
  corporateActionCount,
  latestQuoteAt,
  apiUsage,
  benchmarkCount,
  quoteCount,
  intradayCount,
  historyCount,
  persistenceMode,
  allowPersistentMarketCache,
  serverOrigin,
  autoRefresh,
  setAutoRefresh,
  updateFrequency,
  setUpdateFrequency,
  effectiveUpdateMinutes,
  hideScrollbar,
  setHideScrollbar,
  displayCurrency,
  setDisplayCurrency,
  marketFilter,
  dividendMarketFilter,
  dividendDisplayCurrency,
  dividendPeriod,
  dividendTaxMode,
  currentUsdJpy,
  notificationCount,
  priceAlertThreshold,
  setPriceAlertThreshold,
}: {
  seed: Seed;
  exportCsv: () => void;
  exportJson: () => void;
  onEncryptedBackup?: (seed: Seed) => void;
  onRestoreBackup?: (file: File) => void;
  allowPlaintextExport?: boolean;
  onLock?: () => Promise<void> | void;
  onLogout?: () => Promise<void> | void;
  dark: boolean;
  setDark: (dark: boolean) => void;
  accentTheme: AccentTheme;
  setAccentTheme: (theme: AccentTheme) => void;
  quoteStatus: MarketStatus;
  benchmarkStatus: MarketStatus;
  historyStatus: MarketStatus;
  historyQuality?: HistoryQuality | null;
  historyCacheMeta?: HistoryCacheMeta | null;
  quoteHealth: FetchHealth;
  historyHealth: FetchHealth;
  dataReconciled: boolean;
  corporateActionCount: number;
  latestQuoteAt: string | null;
  apiUsage: {
    quoteRequests: number;
    benchmarkRequests: number;
    historyRequests: number;
    searchRequests: number;
    historyCacheHits?: number;
    integrityChecks?: number;
    lastQuoteRequest?: string | null;
    lastBenchmarkRequest?: string | null;
    lastHistoryRequest?: string | null;
    lastSearchRequest?: string | null;
  };
  benchmarkCount: number;
  quoteCount: number;
  intradayCount: number;
  historyCount: number;
  persistenceMode?: "local" | "cloud";
  allowPersistentMarketCache?: boolean;
  serverOrigin: string;
  autoRefresh: boolean;
  setAutoRefresh: (autoRefresh: boolean) => void;
  updateFrequency: UpdateFrequency;
  setUpdateFrequency: (freq: UpdateFrequency) => void;
  effectiveUpdateMinutes?: number;
  hideScrollbar: boolean;
  setHideScrollbar: (hide: boolean) => void;
  displayCurrency: DisplayCurrency;
  setDisplayCurrency?: (currency: DisplayCurrency) => void;
  marketFilter: PortfolioFilter;
  dividendMarketFilter?: PortfolioFilter;
  dividendDisplayCurrency?: DisplayCurrency;
  dividendPeriod?: string;
  dividendTaxMode?: "gross" | "net";
  currentUsdJpy?: number | null;
  notificationCount: number;
  priceAlertThreshold: number;
  setPriceAlertThreshold: (threshold: number) => void;
}) {
  const [pendingAction, setPendingAction] = useState<DataSecurityAction | null>(null);
  const latestRequest = [apiUsage.lastQuoteRequest, apiUsage.lastBenchmarkRequest, apiUsage.lastHistoryRequest, apiUsage.lastSearchRequest]
    .filter(Boolean)
    .sort()
    .at(-1) as string | undefined;
  const marketScope = portfolioFilterLabel(marketFilter);
  const historyIntegrity = historyQuality?.status === "valid" ? "正常" : historyQuality ? "要確認" : "未検査";
  const systemHealthy = dataReconciled && (historyQuality?.status as string) !== "invalid" && quoteHealth.failedIds.length === 0;
  const confirmation = pendingAction
    ? {
        "encrypted-backup": {
          title: "バックアップしますか？",
          description: "次の画面でパスフレーズを設定します。",
          confirmLabel: "進む",
          danger: false,
        },
        "export-csv": {
          title: "CSVを書き出しますか？",
          description: "暗号化されていないファイルを保存します。",
          confirmLabel: "書き出す",
          danger: false,
        },
        "export-json": {
          title: "JSONを書き出しますか？",
          description: "暗号化されていないファイルを保存します。",
          confirmLabel: "書き出す",
          danger: false,
        },
        logout: {
          title: "ログアウトしますか？",
          description: "この端末のセッションを終了します。",
          confirmLabel: "ログアウト",
          danger: true,
        },
      }[pendingAction]
    : null;

  useEffect(() => {
    if (!pendingAction) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingAction(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [pendingAction]);

  const confirmPendingAction = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === "encrypted-backup") onEncryptedBackup?.(seed);
    if (action === "export-csv") exportCsv();
    if (action === "export-json") exportJson();
    if (action === "logout") void onLogout?.();
  };

  return (
    <div className="settings-page-container">
      <div className="settings-page">
        <section className="settings-brand-card panel" aria-label="株トラについて">
          <div className="settings-brand-content">
            <img src="/kabutora-logo.png" alt="株トラ" className="settings-brand-logo" width="192" height="192" />
            <div className="settings-brand-meta">
              <h2 className="settings-brand-title">株トラ</h2>
              <div className="settings-brand-info-list" aria-label="アプリ主要情報">
                <div className="settings-brand-info-item">
                  <span className="badge-label">バージョン</span>
                  <span className="badge-value">v{APP_VERSION}</span>
                </div>
                <div className="settings-brand-info-item">
                  <span className="badge-label">リリース日</span>
                  <span className="badge-value">{APP_RELEASE_DATE}</span>
                </div>
                {CLIENT_BUILD_ID && CLIENT_BUILD_ID !== "development" && (
                  <div className="settings-brand-info-item" title={`ビルドID: ${CLIENT_BUILD_ID}`}>
                    <span className="badge-label">ビルド</span>
                    <span className="badge-value">{CLIENT_BUILD_ID.replace(/^kabutora-/, "").slice(0, 7)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-card panel" aria-labelledby="settings-preferences-title">
          <header className="settings-card-header">
            <div>
              <h2 id="settings-preferences-title">一般</h2>
            </div>
          </header>
          <div className="settings-rows">
            <div className="settings-row">
              <div>
                <strong>ダークモード</strong>
              </div>
              <button type="button" className="toggle" data-on={dark} onClick={() => setDark(!dark)} aria-label="ダークモード" aria-pressed={dark}>
                <i />
              </button>
            </div>
            <div className="settings-row settings-theme-row">
              <div>
                <strong>テーマカラー</strong>
              </div>
              <div className="theme-options" role="radiogroup" aria-label="テーマカラー">
                {ACCENT_THEMES.map((theme) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={accentTheme === theme.id}
                    className={accentTheme === theme.id ? "active" : ""}
                    key={theme.id}
                    onClick={() => setAccentTheme(theme.id)}
                    aria-label={theme.label}
                    title={theme.label}
                  >
                    <i data-color={theme.id} />
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>表示通貨</strong>
                <small>資産評価とポートフォリオの基準通貨</small>
              </div>
              <select
                className="settings-select"
                value={displayCurrency}
                onChange={(event) => setDisplayCurrency?.(event.target.value as DisplayCurrency)}
                aria-label="表示通貨"
              >
                <option value="JPY">JPY（日本円）</option>
                <option value="USD">USD（米ドル）</option>
                <option value="NATIVE">現地通貨（米国株: USD / 日本株: JPY / その他: JPY）</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>スクロールバーを隠す</strong>
              </div>
              <button
                type="button"
                className="toggle"
                data-on={hideScrollbar}
                onClick={() => setHideScrollbar(!hideScrollbar)}
                aria-label="スクロールバーを隠す"
                aria-pressed={hideScrollbar}
              >
                <i />
              </button>
            </div>
            <div className="settings-row">
              <div>
                <strong>価格を自動更新</strong>
              </div>
              <button
                type="button"
                className="toggle"
                data-on={autoRefresh}
                onClick={() => setAutoRefresh(!autoRefresh)}
                aria-label="価格を自動更新"
                aria-pressed={autoRefresh}
              >
                <i />
              </button>
            </div>
            <div className="settings-row">
              <div>
                <strong>更新間隔</strong>
              </div>
              <select
                className="settings-select"
                value={updateFrequency}
                onChange={(event) => setUpdateFrequency(Number(event.target.value) as UpdateFrequency)}
                disabled={!autoRefresh}
                aria-label="価格の更新間隔"
              >
                {UPDATE_FREQUENCIES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes}分
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>変動通知の基準値</strong>
                <small>前日比の急変動として検知する閾値</small>
              </div>
              <select
                className="settings-select"
                value={priceAlertThreshold}
                onChange={(event) => setPriceAlertThreshold(Number(event.target.value))}
                aria-label="前日比変動通知の基準値"
              >
                {PRICE_ALERT_THRESHOLDS.map((percent) => (
                  <option key={percent} value={percent}>
                    ±{percent}%
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="settings-card panel" aria-labelledby="settings-data-title">
          <header className="settings-card-header">
            <div>
              <h2 id="settings-data-title">データとセキュリティ</h2>
            </div>
            <span className={`settings-state ${persistenceMode === "cloud" ? "ready" : ""}`}>{persistenceMode === "cloud" ? "クラウド" : "端末内"}</span>
          </header>
          <div className="settings-stats" aria-label="保存データの概要">
            <div>
              <strong>{seed.transactions.length.toLocaleString("ja-JP")}</strong>
              <span>取引</span>
            </div>
            <div>
              <strong>{seed.securities.length.toLocaleString("ja-JP")}</strong>
              <span>銘柄</span>
            </div>
            <div>
              <strong>{notificationCount.toLocaleString("ja-JP")}</strong>
              <span>通知</span>
            </div>
          </div>
          <div className="settings-actions">
            {onRestoreBackup && <label className="file-button">バックアップを復元<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onRestoreBackup(file); event.target.value = ""; }}/></label>}
            {onEncryptedBackup && (
              <button className="trade-button" onClick={() => setPendingAction("encrypted-backup")}>
                <ShieldCheck size={13} />
                バックアップ
              </button>
            )}
            {allowPlaintextExport && (
              <>
                <button className="secondary-button" onClick={() => setPendingAction("export-csv")}>
                  <Download size={13} />
                  CSV
                </button>
                <button className="secondary-button" onClick={() => setPendingAction("export-json")}>
                  <Download size={13} />
                  JSON
                </button>
              </>
            )}
          </div>
          {onLogout && (
            <div className="settings-session">
              <button type="button" className="danger-button" onClick={() => setPendingAction("logout")}>
                <LogOut size={13} />
                ログアウト
              </button>
            </div>
          )}
        </section>

        <details className="settings-card settings-system panel" open>
          <summary>
            <div>
              <strong>システム情報</strong>
            </div>
            <span className={`settings-state ${systemHealthy ? "ready" : "warning"}`}>{systemHealthy ? "正常" : "要確認"}</span>
          </summary>
          <div className="system-status-grid">
            <div>
              <span>集計</span>
              <strong className={dataReconciled ? "" : "down"}>{dataReconciled ? "正常" : "不一致"}</strong>
            </div>
            <div>
              <span>価格</span>
              <strong>
                {quoteHealth.returned || quoteCount}/{quoteHealth.requested || seed.securities.length}銘柄
              </strong>
            </div>
            <div>
              <span>日足</span>
              <strong>{historyCount.toLocaleString("ja-JP")}本</strong>
            </div>
            <div>
              <span>市場指標</span>
              <strong>{benchmarkCount}/5件</strong>
            </div>
            <div>
              <span>履歴検査</span>
              <strong>{historyIntegrity}</strong>
            </div>
            <div>
              <span>株式分割</span>
              <strong>{corporateActionCount}件</strong>
            </div>
          </div>
          <dl className="system-details">
            <div>
              <dt>表示設定</dt>
              <dd>
                サマリー: {marketScope} · {displayCurrency === "NATIVE" ? "現地通貨" : displayCurrency}
                {dividendMarketFilter ? ` / 配当: ${portfolioFilterLabel(dividendMarketFilter)} · ${dividendDisplayCurrency === "NATIVE" ? "現地通貨" : (dividendDisplayCurrency ?? "JPY")} · ${dividendTaxMode === "net" ? "税引後" : "税引前"}${dividendPeriod && dividendPeriod !== "ALL" ? ` (${dividendPeriod === "LTM" ? "直近12か月" : `${dividendPeriod}年`})` : " (全期間)"}` : ""}
                {currentUsdJpy ? ` · USD/JPY ${benchmarkNumber.format(currentUsdJpy)}` : ""}
              </dd>
            </div>
            <div>
              <dt>最終価格</dt>
              <dd>
                {latestQuoteAt ? shortDateTimeJa(latestQuoteAt) : "未取得"} · {quoteStatus}
              </dd>
            </div>
            <div>
              <dt>データ状態</dt>
              <dd>
                指標 {benchmarkStatus} · 履歴 {historyStatus} · 日中足 {intradayCount.toLocaleString("ja-JP")}本
              </dd>
            </div>
            <div>
              <dt>フォールバック</dt>
              <dd>
                価格 {quoteHealth.fallbackIds.length}件 · 履歴 {historyHealth.fallbackIds.length}件 · 未取得 {quoteHealth.failedIds.length}件
              </dd>
            </div>
            <div>
              <dt>保存</dt>
              <dd>
                {allowPersistentMarketCache ? "端末キャッシュ有効" : "メモリのみ"}
                {historyCacheMeta?.savedAt ? ` · ${shortDateTimeJa(historyCacheMeta.savedAt)}` : ""}
              </dd>
            </div>
            <div>
              <dt>通信</dt>
              <dd>
                価格 {apiUsage.quoteRequests} · 指標 {apiUsage.benchmarkRequests} · 履歴 {apiUsage.historyRequests} · 検索 {apiUsage.searchRequests}
                {latestRequest ? ` · 最終 ${timeJa(latestRequest)}` : ""}
              </dd>
            </div>
            <div>
              <dt>接続先</dt>
              <dd>{serverOrigin}</dd>
            </div>
          </dl>
        </details>
      </div>
      {confirmation &&
        createPortal(
          <div
            className="modal-layer delete-confirm-layer"
            role="presentation"
            onMouseDown={(event) => event.target === event.currentTarget && setPendingAction(null)}
          >
            <section
              className={`delete-confirm settings-confirm${confirmation.danger ? " danger" : ""}`}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="settings-confirm-title"
              aria-describedby="settings-confirm-description"
            >
              <div className="delete-confirm-heading">
                <h2 id="settings-confirm-title">{confirmation.title}</h2>
              </div>
              <p id="settings-confirm-description">{confirmation.description}</p>
              <div className="delete-confirm-actions">
                <button type="button" className="secondary-button" autoFocus onClick={() => setPendingAction(null)}>
                  キャンセル
                </button>
                <button type="button" className={confirmation.danger ? "danger-button" : "trade-button"} onClick={confirmPendingAction}>
                  {confirmation.confirmLabel}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}

export const FastSettingsView = memo(SettingsView);
