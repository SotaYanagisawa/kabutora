"use client";

/**
 * Dashboard coordinator: composes the feature hooks and lays out the shell and views.
 *
 *   use-dashboard-preferences  user settings, persistence and cloud reconciliation
 *   use-view-navigation        active/retained views, scroll memory, security detail page
 *   use-market-data            market snapshot polling, history, browser cache
 *   use-portfolio              the engine: valuation, history, dividends, notifications
 *   use-touch-gestures         swipe navigation and pull-to-refresh
 *   use-trade-editor           trade modal, transaction deletion, account removal
 */
import { marketKey } from "@kabutora/domain/market";
import { ArrowLeft, Eye, EyeOff, Moon, Plus, RefreshCw, Sun } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { BrowserPreferences, useBrowserPreferences } from "@/components/app/browser-preferences";
import WatchlistView from "@/components/watchlist/watchlist-view";
import { normalizeRequestedSecurity } from "@/lib/market/market-security";
import { getEmbeddedCatalogSecurities } from "@/lib/market/stock-catalog";
import type { PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import { MOBILE_NAV_ITEMS, NAV_ITEMS } from "./constants";
import { DeleteTransactionDialog } from "./delete-transaction-dialog";
import { FastDividendsView } from "./dividends-view";
import { csvEscape, download } from "./helpers";
import { FastNotificationsView } from "./notifications-view";
import { FastOverview } from "./overview-view";
import { RemoveAccountDialog } from "./remove-account-dialog";
import { RetainedView } from "./retained-view";
import { SecurityDetailView } from "./security-detail-view";
import { FastSettingsView } from "./settings-view";
import { FastActivityView } from "./activity-view";
import { TradeModal } from "./trade-modal";
import type { DashboardProps, DisplayCurrency, SearchSecurity, Seed, UserPreferences } from "./types";
import { UpdatingBanner } from "./updating-banner";
import { useDashboardPreferences } from "./use-dashboard-preferences";
import { useMarketData } from "./use-market-data";
import { usePortfolio } from "./use-portfolio";
import { useTouchGestures } from "./use-touch-gestures";
import { useTradeEditor } from "./use-trade-editor";
import { useViewNavigation } from "./use-view-navigation";

const FastWatchlistView = memo(WatchlistView);

function Brand() {
  return (
    <div className="brand" aria-label="株トラ">
      <img src="/kabutora-logo.png" alt="" className="brand-logo" width="26" height="26" />
      <strong>株トラ</strong>
    </div>
  );
}

/** Securities referenced anywhere: seed, user-added, watchlist, and traded IDs resolved via the catalog. */
function collectSecurities(seedSecurities: SearchSecurity[], customSecurities: SearchSecurity[], watchlist: SearchSecurity[], transactions: Seed["transactions"]) {
  const map = new Map<string, SearchSecurity>();
  for (const security of [...seedSecurities, ...customSecurities, ...watchlist]) map.set(security.id, security);
  const catalog = getEmbeddedCatalogSecurities();
  for (const transaction of transactions) {
    if (!transaction.securityId || map.has(transaction.securityId)) continue;
    const canonical = marketKey(transaction.securityId);
    const symbol = canonical.replace(/^sec-(?:us-)?/i, "").toLowerCase();
    const match = catalog.find((item) => marketKey(item.id) === canonical || item.displaySymbol.toLowerCase() === symbol);
    if (match) {
      map.set(transaction.securityId, {
        id: transaction.securityId, displaySymbol: match.displaySymbol, name: match.name, assetType: match.assetType, country: match.country,
        exchangeMic: match.exchangeMic, currency: match.currency, exchangeLabel: match.exchangeLabel, providerSymbols: match.providerSymbols ?? {},
      });
      continue;
    }
    const requested = normalizeRequestedSecurity(transaction.securityId);
    if (requested) {
      map.set(transaction.securityId, {
        id: transaction.securityId, displaySymbol: requested.displaySymbol, name: requested.displaySymbol,
        assetType: requested.venueCode === "FUND" || requested.venueCode === "USD_FUND" ? "fund" : requested.venueCode === "INDEX" ? "index" : "stock",
        country: requested.currency === "USD" ? "US" : "JP", exchangeMic: requested.exchangeMic, currency: requested.currency,
        exchangeLabel: requested.exchangeMic, providerSymbols: { yahoo: requested.providerSymbol },
      });
    }
  }
  return [...map.values()];
}

/** Replaces local state with the synced seed only when it actually differs. */
function syncedList<T>(current: T[], incoming: T[]) {
  if (current === incoming) return current;
  return current.length === incoming.length && current.every((item, i) => JSON.stringify(item) === JSON.stringify(incoming[i])) ? current : incoming;
}

export default function Dashboard(props: DashboardProps) {
  return <BrowserPreferences persistent={props.allowPersistentMarketCache !== false} namespace={props.preferenceNamespace}><DashboardContents {...props}/></BrowserPreferences>;
}

function DashboardContents(props: DashboardProps) {
  const {
    seed, persistenceMode = "local", allowPlaintextExport = true, allowPersistentMarketCache = true,
    onTransactionsChange, onAccountsChange, onSecuritiesChange, onWatchlistChange, onEncryptedBackup, onRestoreBackup, onLogout, onStartupReady,
  } = props;
  const storage = useBrowserPreferences();
  const prefs = useDashboardPreferences({ seed, storage, onPreferencesChange: props.onPreferencesChange, onWatchlistChange });
  const { watchlist, setWatchlist, displayCurrency, set } = prefs;
  // Filter changes re-run the engine; deferring keeps the select controls responsive.
  const calculationBrokerFilter = useDeferredValue(prefs.summaryBrokerFilter);
  const calculationMarketFilter = useDeferredValue(prefs.summaryMarketFilter);
  const nav = useViewNavigation(seed.securities[0]?.id ?? "");
  const { view, navigateToView, detailSecurityId } = nav;
  const [transactions, setTransactions] = useState<Seed["transactions"]>(seed.transactions);
  const [accounts, setAccounts] = useState<Seed["accounts"]>(seed.accounts);
  const [customSecurities, setCustomSecurities] = useState<SearchSecurity[]>([]);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (persistenceMode !== "cloud") return;
    setTransactions((current) => syncedList(current, seed.transactions));
    setAccounts((current) => syncedList(current, seed.accounts));
  }, [persistenceMode, seed.accounts, seed.transactions]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  // ---- Ledger inputs ----------------------------------------------------------------
  const allSecurities = useMemo(() => collectSecurities(seed.securities as SearchSecurity[], customSecurities, watchlist, transactions), [customSecurities, seed.securities, transactions, watchlist]);
  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archivedAt), [accounts]);

  // ---- Market data ----------------------------------------------------------------------
  // Only the earliest needed year leaves the device; the response covers the whole catalog.
  const historyFrom = useMemo(() => {
    const dates = transactions.map((transaction) => transaction.tradeDate.slice(0, 10)).filter(Boolean).sort();
    const year = Math.min(Number((dates[0] ?? new Date().toISOString()).slice(0, 4)), watchlist.length ? new Date().getUTCFullYear() - 1 : 9999);
    return `${year}-01-01`;
  }, [transactions, watchlist.length]);
  const registerIds = useMemo(() => persistenceMode === "local"
    ? [...new Set([...transactions.map((transaction) => transaction.securityId), ...watchlist.map((item) => item.id)].filter((id): id is string => Boolean(id)).map(marketKey))]
    : undefined, [persistenceMode, transactions, watchlist]);
  const market = useMarketData({
    historyFrom,
    autoRefresh: prefs.autoRefresh,
    updateSeconds: prefs.updateFrequency,
    persist: allowPersistentMarketCache,
    registerIds,
  });
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { setClock(Date.now()); }, [market.updatedAt]);
  const now = clock + market.clockOffset;

  const vm = usePortfolio({
    seed, transactions, accountMap, allSecurities, watchlist, market, now,
    displayCurrency, brokerFilter: calculationBrokerFilter, marketFilter: calculationMarketFilter,
    dividendDisplayCurrency: prefs.dividendDisplayCurrency, dividendMarketFilter: prefs.dividendMarketFilter,
    range: prefs.range, customRange: prefs.customRange,
    priceAlertThreshold: prefs.priceAlertThreshold, notificationHistory: prefs.notificationHistory, setNotificationHistory: prefs.setNotificationHistory,
    readNotificationIds: prefs.readNotificationIds, view, detailSecurityId,
  });
  const { rawSecurityMap } = vm;

  const { refresh: refreshMarketData, isRefreshing: isManualRefreshing } = market;
  const refreshMarket = useCallback(async (force = true) => {
    const result = await refreshMarketData(force);
    showToast(result === "updated" ? "市場データを更新しました"
      : result === "partial" ? "一部の市場データを取得できませんでした。保存済み価格を表示しています"
      : "更新に失敗しました");
  }, [refreshMarketData, showToast]);

  const gestures = useTouchGestures({ view, navigateToView, closeSecurity: nav.closeSecurity, refreshMarket, isManualRefreshing });

  // ---- Securities, watchlist and navigation actions ----------------------------------------
  /** Adds a searched security to the user's custom securities if it is not already known. */
  const rememberSecurity = useCallback((security: SearchSecurity) => {
    if (allSecurities.some((item) => item.id === security.id)) return;
    const next = [...customSecurities, security];
    setCustomSecurities(next);
    void onSecuritiesChange?.([...seed.securities, ...next]);
  }, [allSecurities, customSecurities, onSecuritiesChange, seed.securities]);

  const { showSecurity } = nav;
  const openSecurity = useCallback((securityOrId: string | SearchSecurity, origin?: typeof view) => {
    if (typeof securityOrId === "object") setCustomSecurities((prev) => prev.some((item) => item.id === securityOrId.id) ? prev : [...prev, securityOrId]);
    showSecurity(typeof securityOrId === "object" ? securityOrId.id : securityOrId, origin);
  }, [showSecurity]);
  const { setSummaryBrokerFilter, setSummaryMarketFilter } = prefs;
  const openNotificationSecurity = useCallback((securityId: string) => {
    setSummaryBrokerFilter("ALL");
    setSummaryMarketFilter("ALL");
    openSecurity(securityId, "notifications");
  }, [openSecurity, setSummaryBrokerFilter, setSummaryMarketFilter]);
  const openOverviewSecurity = useCallback((securityId: string) => openSecurity(securityId, "overview"), [openSecurity]);
  const openDividendSecurity = useCallback((securityId: string) => openSecurity(securityId, "dividends"), [openSecurity]);
  const openWatchlistSecurity = useCallback((security: SearchSecurity | string) => openSecurity(security, "watchlist"), [openSecurity]);

  const handleAddWatchlist = useCallback((security: SearchSecurity) => {
    setWatchlist((current) => {
      if (current.some((item) => item.id === security.id)) return current;
      const next = [...current, security];
      void onWatchlistChange?.(next);
      return next;
    });
    rememberSecurity(security);
  }, [onWatchlistChange, rememberSecurity, setWatchlist]);
  const handleRemoveWatchlist = useCallback((securityId: string) => {
    setWatchlist((current) => {
      const next = current.filter((item) => item.id !== securityId);
      void onWatchlistChange?.(next);
      return next;
    });
  }, [onWatchlistChange, setWatchlist]);

  const trade = useTradeEditor({
    portfolioId: seed.portfolio.id, transactions, setTransactions, accounts, setAccounts, accountMap, activeAccounts, securityMap: rawSecurityMap,
    rememberSecurity, initialSecurityId: seed.securities[0]?.id ?? "",
    view, detailSecurityId, navigateToView, showToast, onTransactionsChange, onAccountsChange,
  });

  // ---- Notifications, exports, diagnostics ---------------------------------------------------
  const { setReadNotificationIds } = prefs;
  const markNotificationsRead = useCallback((ids: string[]) => {
    setReadNotificationIds((current) => {
      const known = new Set(current);
      const toAdd = ids.filter((id) => Boolean(id) && !known.has(id));
      return toAdd.length ? [...current, ...toAdd] : current;
    });
  }, [setReadNotificationIds]);
  const markNotificationRead = useCallback((id: string) => markNotificationsRead([id]), [markNotificationsRead]);
  const { notifications: portfolioNotifications } = vm;
  const markAllNotificationsRead = useCallback((targetIds?: string[]) => {
    markNotificationsRead(Array.isArray(targetIds) && targetIds.length ? targetIds : portfolioNotifications.map((notice) => notice.id));
  }, [markNotificationsRead, portfolioNotifications]);

  const currentPreferences = useMemo<UserPreferences>(() => ({ ...prefs.preferences, lastUsdJpy: vm.currentUsdJpy ?? undefined }), [prefs.preferences, vm.currentUsdJpy]);
  const exportCsv = useCallback(() => {
    const header = ["schema_version", "transaction_id", "account_id", "symbol", "exchange_mic", "type", "trade_datetime", "quantity", "price_per_share", "trade_currency", "gross_amount", "source"];
    const rows = transactions.map((transaction) => {
      const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : undefined;
      return [1, transaction.id, transaction.accountId, security?.displaySymbol ?? "", security?.exchangeMic ?? "", transaction.type, transaction.tradeDate, transaction.quantity, transaction.pricePerShare, transaction.tradeCurrency, transaction.grossAmount, transaction.source];
    });
    download("kabutora-transactions.csv", `\uFEFF${[header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
    showToast("CSVを書き出しました");
  }, [rawSecurityMap, showToast, transactions]);
  const exportJson = useCallback(() => {
    download("kabutora-backup.json", JSON.stringify({
      schemaVersion: 1, exportedAt: new Date().toISOString(), portfolio: seed.portfolio, accounts, securities: allSecurities, transactions, watchlist, preferences: currentPreferences,
    }, null, 2), "application/json");
    showToast("バックアップを書き出しました");
  }, [accounts, allSecurities, currentPreferences, seed.portfolio, showToast, transactions, watchlist]);
  const settingsSeed = useMemo<Seed>(() => ({ ...seed, accounts, securities: allSecurities, transactions, watchlist, preferences: currentPreferences }), [accounts, allSecurities, currentPreferences, seed, transactions, watchlist]);

  useLayoutEffect(() => { onStartupReady?.(); }, [onStartupReady]);

  // ---- Layout ---------------------------------------------------------------------------
  const { dark, summaryAmountsVisible, autoRefresh } = prefs;
  const { quoteStatus, historyStatus } = market;
  const { summary, unreadNotificationCount } = vm;
  const detailNotifications = useMemo(() => portfolioNotifications.filter((notice) => notice.securityId === detailSecurityId), [detailSecurityId, portfolioNotifications]);
  const notificationBadge = unreadNotificationCount > 0 && <b className="notification-badge">{Math.min(99, unreadNotificationCount)}</b>;
  return (
    <div ref={gestures.appShellRef} className={`app-shell ${dark ? "theme-dark" : "theme-light"}`} {...gestures.touchHandlers}>
      <header className="app-header">
        <Brand />
        <nav className="desktop-nav" aria-label="主要メニュー">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? "active" : ""} aria-label={item.label} onClick={() => navigateToView(item.id)}>
              {item.label}
              {item.id === "notifications" && notificationBadge}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className={`market-health ${quoteStatus}`} title={autoRefresh ? `自動価格更新 ${prefs.updateFrequency}秒間隔` : "自動価格更新オフ"}><i />{quoteStatus === "loading" ? "取得中" : `${summary.pricedCount}/${summary.pricedCount + summary.unpricedCount}`}</span>
          <div className="header-filters" role="group" aria-label="ポートフォリオ表示フィルター">
            <label className="broker-filter" title="証券会社で保有銘柄と取引履歴を絞り込み"><span>証券会社</span><select aria-label="証券会社で絞り込み" value={prefs.summaryBrokerFilter} onChange={(event) => set.summaryBrokerFilter(event.target.value)}><option value="ALL">全口座</option>{vm.brokerOptions.map((broker) => <option key={broker} value={broker}>{broker.replace("証券", "")}</option>)}</select></label>
            <label className="market-filter" title="資産区分と個別株の国でポートフォリオを絞り込み"><span>資産区分</span><select aria-label="資産区分と国で絞り込み" value={prefs.summaryMarketFilter} onChange={(event) => set.summaryMarketFilter(event.target.value as PortfolioFilter)}><option value="ALL">全資産</option><option value="JP">日本株</option><option value="US">米国株</option><option value="FUNDS_INDEXES">投信・指数</option></select></label>
            <label className="currency-filter" title="表示通貨"><span>表示通貨</span><select aria-label="表示通貨" value={displayCurrency} onChange={(event) => set.displayCurrency(event.target.value as DisplayCurrency)}><option value="JPY">JPY</option><option value="USD">USD</option><option value="NATIVE">現地通貨</option></select></label>
          </div>
          <div className="header-tools">
            <button className="icon-button" onClick={() => set.summaryAmountsVisible((visible) => !visible)} aria-label={summaryAmountsVisible ? "金額を非表示" : "金額を表示"} title={summaryAmountsVisible ? "金額を非表示" : "金額を表示"}>{summaryAmountsVisible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
            <button className="icon-button" onClick={() => void refreshMarket()} aria-label="市場データを更新"><RefreshCw size={17} /></button>
            <button className="icon-button" onClick={() => set.dark((value) => !value)} aria-label="テーマを切り替え">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button className="trade-button" aria-label="取引を記録" onClick={trade.openNewTrade}><Plus size={16} /><span>取引</span></button>
          </div>
        </div>
      </header>

      <main
        ref={gestures.workspaceRef}
        className="workspace"
        data-history-status={historyStatus}
        data-navigation-views-preloaded={NAV_ITEMS.every((item) => nav.mountedViews.has(item.id))}
      >
        {nav.mountedViews.has("activity") && <RetainedView active={view === "activity"}>
          <FastActivityView transactions={transactions} securityMap={rawSecurityMap} accountMap={accountMap} tradeRows={vm.tradeRows} brokerOptions={vm.brokerOptions} onEdit={trade.requestTransactionEdit} onDelete={trade.requestTransactionDelete} onOpenTrade={trade.openNewTrade} />
        </RetainedView>}
        {nav.mountedViews.has("dividends") && <RetainedView active={view === "dividends"}>
          <FastDividendsView
            receipts={vm.receipts}
            fxUnavailable={vm.dividendFxUnavailable}
            securityMap={rawSecurityMap}
            accountMap={accountMap}
            currency={vm.effectiveDividendCurrency}
            displayCurrency={prefs.dividendDisplayCurrency}
            onDisplayCurrencyChange={set.dividendDisplayCurrency}
            marketFilter={prefs.dividendMarketFilter}
            onMarketFilterChange={set.dividendMarketFilter}
            period={prefs.dividendPeriod}
            onPeriodChange={set.dividendPeriod}
            taxMode={prefs.dividendTaxMode}
            onTaxModeChange={set.dividendTaxMode}
            activeTab={prefs.dividendActiveTab}
            onActiveTabChange={set.dividendActiveTab}
            distributionStatus={historyStatus}
            distributionError={market.historyError}
            todayKey={new Date(now + 9 * 3_600_000).toISOString().slice(0, 10)}
            amountsVisible={summaryAmountsVisible}
            onSelectSecurity={openDividendSecurity}
          />
        </RetainedView>}
        {nav.mountedViews.has("overview") && <RetainedView active={view === "overview"}>
          <FastOverview
            summary={summary} holdings={vm.holdings} history={vm.history} historyStatus={historyStatus}
            quoteStatus={quoteStatus} marketSessions={vm.marketSessions} marketError={market.marketError} historyError={market.historyError} benchmarks={market.benchmarks}
            range={prefs.range} setRange={set.range} refreshMarket={refreshMarket}
            marketFilter={prefs.summaryMarketFilter} setMarketFilter={set.summaryMarketFilter} brokerFilter={prefs.summaryBrokerFilter} setBrokerFilter={set.summaryBrokerFilter} brokerOptions={vm.brokerOptions} setDisplayCurrency={set.displayCurrency} amountsVisible={summaryAmountsVisible} setAmountsVisible={set.summaryAmountsVisible}
            customRange={prefs.customRange} setCustomRange={set.customRange} dateBounds={vm.portfolioDateBounds}
            onSelectSecurity={openOverviewSecurity} currency={displayCurrency} summaryCurrency={vm.summaryCurrency}
          />
        </RetainedView>}
        {nav.mountedViews.has("watchlist") && <RetainedView active={view === "watchlist"}>
          <FastWatchlistView
            watchlist={watchlist}
            onAddSecurity={handleAddWatchlist}
            onRemoveSecurity={handleRemoveWatchlist}
            securityMap={rawSecurityMap}
            onSelectSecurity={openWatchlistSecurity}
            allSecurities={allSecurities}
          />
        </RetainedView>}
        {nav.mountedViews.has("notifications") && <RetainedView active={view === "notifications"}>
          <FastNotificationsView notifications={portfolioNotifications} securityMap={rawSecurityMap} detailSecurityIds={vm.tradedSecurityIds} readNotificationIds={prefs.readNotificationIds} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} onOpenSecurity={openNotificationSecurity}/>
        </RetainedView>}
        {nav.mountedViews.has("settings") && <RetainedView active={view === "settings"}>
          <FastSettingsView seed={settingsSeed} exportCsv={exportCsv} exportJson={exportJson} onEncryptedBackup={onEncryptedBackup} onRestoreBackup={onRestoreBackup} allowPlaintextExport={allowPlaintextExport} onLogout={onLogout} dark={dark} setDark={set.dark} accentTheme={prefs.accentTheme} setAccentTheme={set.accentTheme} diagnostics={vm.diagnostics} persistenceMode={persistenceMode} allowPersistentMarketCache={allowPersistentMarketCache} serverOrigin={window.location.origin} autoRefresh={autoRefresh} setAutoRefresh={set.autoRefresh} updateFrequency={prefs.updateFrequency} setUpdateFrequency={set.updateFrequency} hideScrollbar={prefs.hideScrollbar} setHideScrollbar={set.hideScrollbar} displayCurrency={displayCurrency} setDisplayCurrency={set.displayCurrency} marketFilter={prefs.summaryMarketFilter} dividendMarketFilter={prefs.dividendMarketFilter} dividendDisplayCurrency={prefs.dividendDisplayCurrency} dividendPeriod={prefs.dividendPeriod} dividendTaxMode={prefs.dividendTaxMode} notificationCount={portfolioNotifications.length} priceAlertThreshold={prefs.priceAlertThreshold} setPriceAlertThreshold={set.priceAlertThreshold} />
        </RetainedView>}
        {view === "security" && (
          <div className="view-cache active" style={{ display: "block" }}>
            {vm.detail ? (
              <SecurityDetailView detail={vm.detail} transactions={vm.detailTransactions} tradeRows={vm.tradeRows} accountMap={accountMap} historyStatus={historyStatus} onBack={nav.closeSecurity} returnView={nav.detailReturnView} currency={displayCurrency} notifications={detailNotifications} readNotificationIds={prefs.readNotificationIds} onReadNotification={markNotificationRead} onEditTransaction={trade.requestTransactionEdit} onDeleteTransaction={trade.requestTransactionDelete} amountsVisible={summaryAmountsVisible}/>
            ) : (
              <div className="security-detail-page">
                <section className="security-detail-header">
                  <div className="detail-heading">
                    <button type="button" className="detail-back" onClick={nav.closeSecurity} aria-label="戻る"><ArrowLeft size={16}/><span>戻る</span></button>
                  </div>
                </section>
                <div className="empty-state" style={{ padding: "60px 20px" }}>
                  <RefreshCw size={24} className="spin" />
                  <p style={{ marginTop: "12px", color: "var(--muted)" }}>銘柄情報を読み込み中…</p>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="mobile-nav" aria-label="モバイルナビゲーション" data-swipe-ignore="true">
        {MOBILE_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id || (view === "security" && item.id === nav.detailReturnView);
          return (
            <button key={item.id} aria-label={item.shortLabel} aria-current={active ? "page" : undefined} className={active ? "active" : ""} onClick={() => navigateToView(item.id)}>
              <span className="mobile-nav-icon">
                <Icon size={25} />
                {item.id === "notifications" && notificationBadge}
              </span>
            </button>
          );
        })}
      </nav>

      <TradeModal {...trade.tradeModalProps} nativeMarketSecurities={vm.nativeMarketSecurities} accountMap={accountMap} persistenceMode={persistenceMode} />
      <DeleteTransactionDialog {...trade.deleteDialogProps} rawSecurityMap={rawSecurityMap} accountMap={accountMap} />
      <RemoveAccountDialog {...trade.removeAccountDialogProps} accountMap={accountMap} transactions={transactions} />
      {toast && <div className="toast" role="status">{toast}</div>}
      <UpdatingBanner
        isManualRefreshing={isManualRefreshing}
        quoteStatus={quoteStatus}
        historyStatus={historyStatus}
        distributionStatus={historyStatus}
        benchmarkStatus={quoteStatus}
        historyBarsCount={market.data.history.size}
        quotesCount={market.data.quotes.size}
      />
    </div>
  );
}
