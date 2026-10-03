"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_PRICE_ALERT_PERCENT, PRICE_ALERT_THRESHOLDS, type PortfolioNotification } from "@/lib/portfolio/portfolio-notifications";
import type { PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import {
  DIVIDEND_DISPLAY_CURRENCY_KEY,
  DIVIDEND_MARKET_FILTER_KEY,
  DIVIDEND_PERIOD_KEY,
  DIVIDEND_TAB_KEY,
  DIVIDEND_TAX_MODE_KEY,
  HIDE_SCROLLBAR_KEY,
  LEGACY_MARKET_FILTER_KEY,
  PORTFOLIO_RANGES,
  PRICE_ALERT_THRESHOLD_KEY,
  SUMMARY_AMOUNTS_VISIBLE_KEY,
  SUMMARY_BROKER_FILTER_KEY,
  SUMMARY_CUSTOM_RANGE_KEY,
  SUMMARY_MARKET_FILTER_KEY,
  SUMMARY_RANGE_KEY,
} from "./constants";
import { readStoredIds, readStoredNotifications } from "./helpers";
import type { AccentTheme, CustomDateRange, DashboardProps, DisplayCurrency, RangeKey, SearchSecurity, Seed, UpdateFrequency, UserPreferences } from "./types";

const THEME_KEY = "kabutora-theme";
const ACCENT_KEY = "kabutora-accent";
const AUTO_REFRESH_KEY = "kabutora-auto-refresh";
const UPDATE_FREQUENCY_KEY = "kabutora-update-frequency";
const DISPLAY_CURRENCY_KEY = "kabutora-display-currency";
const ACKNOWLEDGED_ACTIONS_KEY = "kabutora-acknowledged-actions-v1";
const READ_NOTIFICATIONS_KEY = "kabutora-read-notifications-v1";
const NOTIFICATION_HISTORY_KEY = "kabutora-notification-history-v1";
const WATCHLIST_KEY = "kabutora-watchlist-v1";
/** Plaintext portfolio keys written by very old releases; removed on startup. */
const LEGACY_PLAINTEXT_KEYS = ["kabutora-transactions", "kabutora-accounts-v1", "kabutora-custom-securities-v1"];

const ACCENTS: readonly string[] = ["graphite", "blue", "forest", "plum"];
const FREQUENCIES: readonly number[] = [10, 15, 30, 60];
const CURRENCIES: readonly string[] = ["JPY", "USD", "NATIVE"];
const FILTERS: readonly string[] = ["ALL", "JP", "US", "FUNDS_INDEXES"];
const pick = <T extends string | number>(value: unknown, allowed: readonly (string | number)[]): T | null =>
  value != null && allowed.includes(value as string | number) ? value as T : null;

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

/** Cloud preferences win; otherwise browser storage; otherwise defaults. */
export function resolveInitialPreferences(seed: Seed, storage: Storage) {
  const cloud = seed.preferences;
  const read = (key: string) => storage.getItem(key);
  const parsedWatchlist = parseJson<unknown>(read(WATCHLIST_KEY));
  const savedWatchlist = Array.isArray(parsedWatchlist) ? parsedWatchlist as SearchSecurity[] : null;
  const savedCustomRange = parseJson<CustomDateRange>(read(SUMMARY_CUSTOM_RANGE_KEY));
  const baseCurrency: DisplayCurrency = seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY";
  const savedRange = read(SUMMARY_RANGE_KEY) as RangeKey | null;
  const savedTaxMode = read(DIVIDEND_TAX_MODE_KEY);
  const savedTab = read(DIVIDEND_TAB_KEY);
  const savedTheme = read(THEME_KEY);
  const savedAccent = read(ACCENT_KEY);
  const savedAutoRefresh = read(AUTO_REFRESH_KEY);
  const savedDisplayCurrency = read(DISPLAY_CURRENCY_KEY);
  return {
    watchlist: seed.watchlist?.length ? seed.watchlist : savedWatchlist?.length ? savedWatchlist : (seed.watchlist ?? []),
    dark: (cloud?.theme ?? savedTheme) === "dark",
    accentTheme: cloud?.accentTheme ?? pick<AccentTheme>(savedAccent, ACCENTS) ?? "graphite",
    autoRefresh: cloud?.autoRefresh ?? savedAutoRefresh !== "false",
    updateFrequency: cloud?.updateFrequency ?? pick<UpdateFrequency>(Number(read(UPDATE_FREQUENCY_KEY)), FREQUENCIES) ?? 15,
    priceAlertThreshold: cloud?.priceAlertThreshold ?? pick<number>(Number(read(PRICE_ALERT_THRESHOLD_KEY)), PRICE_ALERT_THRESHOLDS) ?? DEFAULT_PRICE_ALERT_PERCENT,
    displayCurrency: cloud?.displayCurrency ?? pick<DisplayCurrency>(savedDisplayCurrency, CURRENCIES) ?? baseCurrency,
    summaryMarketFilter: cloud?.summaryMarketFilter ?? pick<PortfolioFilter>(read(SUMMARY_MARKET_FILTER_KEY) ?? read(LEGACY_MARKET_FILTER_KEY), FILTERS) ?? "ALL",
    summaryBrokerFilter: cloud?.summaryBrokerFilter ?? (read(SUMMARY_BROKER_FILTER_KEY) || "ALL"),
    dividendMarketFilter: cloud?.dividendMarketFilter ?? pick<PortfolioFilter>(read(DIVIDEND_MARKET_FILTER_KEY), FILTERS) ?? "ALL",
    dividendDisplayCurrency: cloud?.dividendDisplayCurrency ?? pick<DisplayCurrency>(read(DIVIDEND_DISPLAY_CURRENCY_KEY), CURRENCIES) ?? baseCurrency,
    dividendPeriod: cloud?.dividendPeriod ?? (read(DIVIDEND_PERIOD_KEY) || "ALL"),
    dividendTaxMode: cloud?.dividendTaxMode ?? (savedTaxMode === "gross" || savedTaxMode === "net" ? savedTaxMode : "gross"),
    dividendActiveTab: cloud?.dividendActiveTab ?? (savedTab === "securities" || savedTab === "history" ? savedTab : "securities"),
    range: cloud?.summaryRange ?? (savedRange && (PORTFOLIO_RANGES.includes(savedRange) || savedRange === "CUSTOM") ? savedRange : "ALL"),
    customRange: cloud?.summaryCustomRange ?? (typeof savedCustomRange?.from === "string" && typeof savedCustomRange.to === "string" ? savedCustomRange : null),
    summaryAmountsVisible: cloud?.summaryAmountsVisible ?? read(SUMMARY_AMOUNTS_VISIBLE_KEY) !== "false",
    hideScrollbar: cloud?.hideScrollbar ?? read(HIDE_SCROLLBAR_KEY) !== "false",
    acknowledgedActionIds: [...new Set([...readStoredIds(storage, ACKNOWLEDGED_ACTIONS_KEY), ...(cloud?.acknowledgedActions ?? [])])],
    readNotificationIds: [...new Set([...readStoredIds(storage, READ_NOTIFICATIONS_KEY), ...(cloud?.readNotifications ?? [])])],
    notificationHistory: cloud?.notificationHistory ?? readStoredNotifications(storage),
    /** True when an old browser-only preference set exists and should be uploaded once. */
    needsCloudMigration: !cloud && Boolean(savedTheme || savedDisplayCurrency || savedAccent || savedAutoRefresh),
    hasSavedWatchlist: Boolean(savedWatchlist?.length),
  };
}

/** Mirrors one state value into browser storage (`null` removes the key). */
function useStoredValue<T>(storage: Storage, key: string, value: T, serialize: (value: T) => string | null = String) {
  useEffect(() => {
    const serialized = serialize(value);
    if (serialized == null) storage.removeItem(key);
    else storage.setItem(key, serialized);
    // `serialize` is an inline pure formatter; persistence follows value changes only.
  }, [key, storage, value]); // eslint-disable-line react-hooks/exhaustive-deps
}

const mergeIds = (current: string[], incoming: string[]) => {
  const merged = [...new Set([...current, ...incoming])];
  return merged.length === current.length ? current : merged;
};

type Options = Pick<DashboardProps, "seed" | "onPreferencesChange" | "onWatchlistChange"> & { storage: Storage };

/**
 * Owns every user preference shown in the dashboard: initial resolution,
 * browser persistence, per-field reconciliation with synced cloud preferences,
 * and debounced-upstream change notification through `onPreferencesChange`.
 */
export function useDashboardPreferences({ seed, storage, onPreferencesChange, onWatchlistChange }: Options) {
  const initial = useMemo(() => resolveInitialPreferences(seed, storage), [storage, seed]);
  const [watchlist, setWatchlist] = useState<SearchSecurity[]>(initial.watchlist);
  const [range, setRange] = useState<RangeKey>(initial.range);
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(initial.customRange);
  const [dark, setDark] = useState(initial.dark);
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initial.accentTheme);
  const [summaryBrokerFilter, setSummaryBrokerFilter] = useState(initial.summaryBrokerFilter);
  const [summaryMarketFilter, setSummaryMarketFilter] = useState<PortfolioFilter>(initial.summaryMarketFilter);
  const [dividendMarketFilter, setDividendMarketFilter] = useState<PortfolioFilter>(initial.dividendMarketFilter);
  const [dividendDisplayCurrency, setDividendDisplayCurrency] = useState<DisplayCurrency>(initial.dividendDisplayCurrency);
  const [dividendPeriod, setDividendPeriod] = useState<string>(initial.dividendPeriod);
  const [dividendTaxMode, setDividendTaxMode] = useState<"gross" | "net">(initial.dividendTaxMode);
  const [dividendActiveTab, setDividendActiveTab] = useState<"securities" | "history">(initial.dividendActiveTab);
  const [summaryAmountsVisible, setSummaryAmountsVisible] = useState(initial.summaryAmountsVisible);
  const [hideScrollbar, setHideScrollbar] = useState(initial.hideScrollbar);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(initial.displayCurrency);
  const [autoRefresh, setAutoRefresh] = useState(initial.autoRefresh);
  const [updateFrequency, setUpdateFrequency] = useState<UpdateFrequency>(initial.updateFrequency);
  const [priceAlertThreshold, setPriceAlertThreshold] = useState<number>(initial.priceAlertThreshold);
  const [acknowledgedActionIds, setAcknowledgedActionIds] = useState<string[]>(initial.acknowledgedActionIds);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(initial.readNotificationIds);
  const [notificationHistory, setNotificationHistory] = useState<PortfolioNotification[]>(initial.notificationHistory);

  // Local edit clocks: a synced value only replaces a field this device has not edited more recently.
  const lastLocalPrefTimestampRef = useRef(0);
  const localPrefTimestampsRef = useRef<Partial<Record<keyof UserPreferences, number>>>({});
  const markLocalPrefEdit = useCallback((key: keyof UserPreferences) => {
    const now = Date.now();
    lastLocalPrefTimestampRef.current = now;
    localPrefTimestampsRef.current[key] = now;
  }, []);

  /** Setters for user-initiated changes; each records a local edit clock for its field. */
  const set = useMemo(() => {
    const tracked = <T,>(field: keyof UserPreferences, setter: Dispatch<SetStateAction<T>>) => (next: SetStateAction<T>) => {
      markLocalPrefEdit(field);
      setter(next);
    };
    return {
      range: tracked("summaryRange", setRange),
      customRange: tracked("summaryCustomRange", setCustomRange),
      summaryAmountsVisible: tracked("summaryAmountsVisible", setSummaryAmountsVisible),
      summaryBrokerFilter: tracked("summaryBrokerFilter", setSummaryBrokerFilter),
      summaryMarketFilter: tracked("summaryMarketFilter", setSummaryMarketFilter),
      dividendMarketFilter: tracked("dividendMarketFilter", setDividendMarketFilter),
      dividendDisplayCurrency: tracked("dividendDisplayCurrency", setDividendDisplayCurrency),
      dividendPeriod: tracked("dividendPeriod", setDividendPeriod),
      dividendTaxMode: tracked("dividendTaxMode", setDividendTaxMode),
      dividendActiveTab: tracked("dividendActiveTab", setDividendActiveTab),
      dark: tracked("theme", setDark),
      accentTheme: tracked("accentTheme", setAccentTheme),
      autoRefresh: tracked("autoRefresh", setAutoRefresh),
      updateFrequency: tracked("updateFrequency", setUpdateFrequency),
      hideScrollbar: tracked("hideScrollbar", setHideScrollbar),
      displayCurrency: tracked("displayCurrency", setDisplayCurrency),
      priceAlertThreshold: tracked("priceAlertThreshold", setPriceAlertThreshold),
    };
  }, [markLocalPrefEdit]);

  // One-time startup migration: persist cloud watchlist locally, upload a browser-only
  // watchlist/preference set to the encrypted cloud, and drop legacy plaintext keys.
  useEffect(() => {
    if (seed.watchlist?.length) storage.setItem(WATCHLIST_KEY, JSON.stringify(seed.watchlist));
    else if (initial.hasSavedWatchlist) void onWatchlistChange?.(initial.watchlist);
    else if (storage.getItem(WATCHLIST_KEY)) storage.removeItem(WATCHLIST_KEY);
    for (const key of LEGACY_PLAINTEXT_KEYS) storage.removeItem(key);
    if (initial.needsCloudMigration) {
      void onPreferencesChange?.({
        theme: initial.dark ? "dark" : "light",
        accentTheme: initial.accentTheme,
        autoRefresh: initial.autoRefresh,
        updateFrequency: initial.updateFrequency,
        displayCurrency: initial.displayCurrency,
        summaryMarketFilter: initial.summaryMarketFilter,
        summaryBrokerFilter: initial.summaryBrokerFilter,
        dividendMarketFilter: initial.dividendMarketFilter,
        dividendDisplayCurrency: initial.dividendDisplayCurrency,
        dividendPeriod: initial.dividendPeriod,
        dividendTaxMode: initial.dividendTaxMode,
        dividendActiveTab: initial.dividendActiveTab,
        summaryAmountsVisible: initial.summaryAmountsVisible,
        hideScrollbar: initial.hideScrollbar,
        summaryRange: initial.range,
        priceAlertThreshold: initial.priceAlertThreshold,
        acknowledgedActions: initial.acknowledgedActionIds,
        readNotifications: initial.readNotificationIds,
        notificationHistory: initial.notificationHistory,
        updatedAt: new Date().toISOString(),
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.accent = accentTheme;
    document.documentElement.dataset.hideScrollbar = hideScrollbar ? "true" : "false";
  }, [accentTheme, dark, hideScrollbar]);

  useStoredValue(storage, THEME_KEY, dark, (value) => value ? "dark" : "light");
  useStoredValue(storage, ACCENT_KEY, accentTheme);
  useStoredValue(storage, ACKNOWLEDGED_ACTIONS_KEY, acknowledgedActionIds, (ids) => JSON.stringify(ids.slice(-1000)));
  useStoredValue(storage, READ_NOTIFICATIONS_KEY, readNotificationIds, JSON.stringify);
  useStoredValue(storage, NOTIFICATION_HISTORY_KEY, notificationHistory, JSON.stringify);
  useStoredValue(storage, WATCHLIST_KEY, watchlist, JSON.stringify);
  useStoredValue(storage, AUTO_REFRESH_KEY, autoRefresh);
  useStoredValue(storage, UPDATE_FREQUENCY_KEY, updateFrequency);
  useStoredValue(storage, PRICE_ALERT_THRESHOLD_KEY, priceAlertThreshold);
  useStoredValue(storage, DISPLAY_CURRENCY_KEY, displayCurrency);
  useStoredValue(storage, SUMMARY_MARKET_FILTER_KEY, summaryMarketFilter);
  useStoredValue(storage, LEGACY_MARKET_FILTER_KEY, summaryMarketFilter);
  useStoredValue(storage, SUMMARY_BROKER_FILTER_KEY, summaryBrokerFilter);
  useStoredValue(storage, DIVIDEND_MARKET_FILTER_KEY, dividendMarketFilter);
  useStoredValue(storage, DIVIDEND_DISPLAY_CURRENCY_KEY, dividendDisplayCurrency);
  useStoredValue(storage, DIVIDEND_PERIOD_KEY, dividendPeriod);
  useStoredValue(storage, DIVIDEND_TAX_MODE_KEY, dividendTaxMode);
  useStoredValue(storage, DIVIDEND_TAB_KEY, dividendActiveTab);
  useStoredValue(storage, SUMMARY_AMOUNTS_VISIBLE_KEY, summaryAmountsVisible);
  useStoredValue(storage, HIDE_SCROLLBAR_KEY, hideScrollbar);
  useStoredValue(storage, SUMMARY_RANGE_KEY, range);
  useStoredValue(storage, SUMMARY_CUSTOM_RANGE_KEY, customRange, (value) => value ? JSON.stringify(value) : null);

  const preferences = useMemo<UserPreferences>(() => ({
    theme: dark ? "dark" : "light",
    accentTheme,
    autoRefresh,
    updateFrequency,
    displayCurrency,
    summaryMarketFilter,
    summaryBrokerFilter,
    dividendMarketFilter,
    dividendDisplayCurrency,
    dividendPeriod,
    dividendTaxMode,
    dividendActiveTab,
    summaryAmountsVisible,
    hideScrollbar,
    summaryRange: range,
    summaryCustomRange: customRange,
    priceAlertThreshold,
    acknowledgedActions: acknowledgedActionIds,
    readNotifications: readNotificationIds,
    notificationHistory,
    updatedAt: new Date(lastLocalPrefTimestampRef.current || Date.now()).toISOString(),
  }), [accentTheme, acknowledgedActionIds, autoRefresh, customRange, dark, displayCurrency, dividendActiveTab, dividendDisplayCurrency, dividendMarketFilter, dividendPeriod, dividendTaxMode, hideScrollbar, notificationHistory, priceAlertThreshold, range, readNotificationIds, summaryAmountsVisible, summaryBrokerFilter, summaryMarketFilter, updateFrequency]);

  // Apply synced cloud preferences field by field.
  const incomingPrefTimeRef = useRef<string>("");
  useEffect(() => {
    const p = seed.preferences;
    if (!p) return;
    const incomingTime = p.updatedAt ? Date.parse(p.updatedAt) || 0 : 0;
    incomingPrefTimeRef.current = p.updatedAt ?? "";
    // Event replay already resolves each preference independently using its
    // per-field sequence. A page-wide timestamp check here would incorrectly
    // discard a remote USD change merely because this device had more recently
    // changed the independent JP/US market filter.
    if (incomingTime) lastLocalPrefTimestampRef.current = Math.max(lastLocalPrefTimestampRef.current, incomingTime);
    const canApply = (field: keyof UserPreferences) => {
      const localTime = localPrefTimestampsRef.current[field];
      if (!localTime) return true;
      if ((seed.sync?.preferenceSequences?.[field] ?? incomingTime) >= localTime) {
        delete localPrefTimestampsRef.current[field];
        return true;
      }
      return false;
    };
    if (canApply("theme") && p.theme) setDark(p.theme === "dark");
    if (canApply("accentTheme") && pick(p.accentTheme, ACCENTS)) setAccentTheme(p.accentTheme!);
    if (canApply("autoRefresh") && p.autoRefresh !== undefined) setAutoRefresh(p.autoRefresh);
    if (canApply("updateFrequency") && pick(p.updateFrequency, FREQUENCIES)) setUpdateFrequency(p.updateFrequency!);
    if (canApply("displayCurrency") && pick(p.displayCurrency, CURRENCIES)) setDisplayCurrency(p.displayCurrency!);
    if (canApply("summaryMarketFilter") && pick(p.summaryMarketFilter, FILTERS)) setSummaryMarketFilter(p.summaryMarketFilter!);
    if (canApply("summaryBrokerFilter") && p.summaryBrokerFilter !== undefined) setSummaryBrokerFilter(p.summaryBrokerFilter);
    if (canApply("dividendMarketFilter") && pick(p.dividendMarketFilter, FILTERS)) setDividendMarketFilter(p.dividendMarketFilter!);
    if (canApply("dividendDisplayCurrency") && pick(p.dividendDisplayCurrency, CURRENCIES)) setDividendDisplayCurrency(p.dividendDisplayCurrency!);
    if (canApply("dividendPeriod") && p.dividendPeriod !== undefined) setDividendPeriod(p.dividendPeriod);
    if (canApply("dividendTaxMode") && p.dividendTaxMode) setDividendTaxMode(p.dividendTaxMode);
    if (canApply("dividendActiveTab") && p.dividendActiveTab) setDividendActiveTab(p.dividendActiveTab);
    if (canApply("summaryAmountsVisible") && p.summaryAmountsVisible !== undefined) setSummaryAmountsVisible(p.summaryAmountsVisible);
    if (canApply("hideScrollbar") && p.hideScrollbar !== undefined) setHideScrollbar(p.hideScrollbar);
    if (canApply("summaryRange") && p.summaryRange) setRange(p.summaryRange);
    if (canApply("summaryCustomRange") && p.summaryCustomRange !== undefined) setCustomRange(p.summaryCustomRange);
    if (canApply("priceAlertThreshold") && pick(p.priceAlertThreshold, PRICE_ALERT_THRESHOLDS)) setPriceAlertThreshold(p.priceAlertThreshold!);
    if (Array.isArray(p.acknowledgedActions)) setAcknowledgedActionIds((current) => mergeIds(current, p.acknowledgedActions!));
    if (Array.isArray(p.readNotifications)) setReadNotificationIds((current) => mergeIds(current, p.readNotifications!));
    if (Array.isArray(p.notificationHistory)) setNotificationHistory(p.notificationHistory);
  }, [seed.preferences]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Array.isArray(seed.watchlist)) setWatchlist(seed.watchlist);
  }, [seed.watchlist]);

  // Report locally changed fields (with their edit clocks) upstream.
  const lastPushedPreferencesRef = useRef("");
  useEffect(() => {
    const { updatedAt, ...comparable } = preferences;
    const json = JSON.stringify(comparable);
    if (!lastPushedPreferencesRef.current) {
      lastPushedPreferencesRef.current = json;
      return;
    }
    if (json === lastPushedPreferencesRef.current) return;
    const incomingTime = incomingPrefTimeRef.current ? Date.parse(incomingPrefTimeRef.current) || 0 : 0;
    if (incomingTime && incomingTime > lastLocalPrefTimestampRef.current) {
      lastPushedPreferencesRef.current = json;
      return;
    }
    // Capture edit clocks now. A local optimistic cloud replay may acknowledge
    // the change before the debounce fires and clear the live ref.
    const previous = JSON.parse(lastPushedPreferencesRef.current) as UserPreferences;
    const changed = Object.fromEntries(Object.entries(comparable).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof UserPreferences]))) as UserPreferences;
    const changedSequences = Object.fromEntries(Object.keys(changed).flatMap((key) => {
      const sequence = localPrefTimestampsRef.current[key as keyof UserPreferences];
      return sequence ? [[key, sequence]] : [];
    }));
    lastPushedPreferencesRef.current = json;
    if (updatedAt) incomingPrefTimeRef.current = updatedAt;
    void onPreferencesChange?.({ ...changed, updatedAt, ...(Object.keys(changedSequences).length ? { preferenceSequences: changedSequences } : {}) });
  }, [onPreferencesChange, preferences]);

  return {
    preferences,
    set,
    watchlist, setWatchlist,
    range, customRange, dark, accentTheme,
    summaryBrokerFilter, setSummaryBrokerFilter,
    summaryMarketFilter, setSummaryMarketFilter,
    dividendMarketFilter, dividendDisplayCurrency, dividendPeriod, dividendTaxMode, dividendActiveTab,
    summaryAmountsVisible, hideScrollbar, displayCurrency, autoRefresh, updateFrequency, priceAlertThreshold,
    acknowledgedActionIds, setAcknowledgedActionIds,
    readNotificationIds, setReadNotificationIds,
    notificationHistory, setNotificationHistory,
  };
}
