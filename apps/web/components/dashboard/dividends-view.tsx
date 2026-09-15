import { estimateNetDividendDecimal } from "@/lib/dividend-arithmetic";
import { useBrowserPreferences } from "../browser-preferences";
import { memo, useCallback, useMemo, useState } from "react";
import type { DistributionEvent, DividendReceipt } from "@kabutora/domain";
import { Decimal, canonicalDomainSecurityId } from "@kabutora/domain";
import type { DistributionCoverage } from "@/lib/server-market-types";
import { LightweightBarChart, LightweightLineChart } from "@/components/lightweight-charts";
import { AlertTriangle, ArrowLeft, ArrowRight, Coins, RefreshCw, Search, X } from "lucide-react";
import {
  DIVIDEND_DISPLAY_CURRENCY_KEY,
  DIVIDEND_MARKET_FILTER_KEY,
  DIVIDEND_PERIOD_KEY,
  DIVIDEND_TAB_KEY,
  DIVIDEND_TAX_MODE_KEY,
  HIDDEN_AMOUNT,
} from "./constants";
import {
  compactMoney,
  dateJa,
  money,
  number,
  securityQuantityUnit,
} from "./helpers";
import {
  isFundSecurity,
  isIndexSecurity,
  isEtfSecurity,
  isUsSecurity,
  isJpSecurity,
  securityAssetLabel,
  securityMatchesPortfolioFilter,
  type PortfolioFilter,
} from "@/lib/portfolio-filter";
import { getEmbeddedCatalogSecurities } from "@/lib/stock-catalog";
import { normalizeRequestedSecurity } from "@/lib/market-security";
import type { DisplayCurrency, MarketStatus, SearchSecurity, Seed } from "./types";

const embeddedCatalogSecurities = new Map(getEmbeddedCatalogSecurities().map((s) => [canonicalDomainSecurityId(s.id), s]));

export function resolveSecurity(
  securityId: string,
  securityMap: Map<string, (Seed["securities"][number] & { name?: string }) | SearchSecurity>,
) {
  if (securityMap.has(securityId)) return securityMap.get(securityId)!;
  const canonical = canonicalDomainSecurityId(securityId);
  if (securityMap.has(canonical)) return securityMap.get(canonical)!;
  for (const s of securityMap.values()) {
    if (s.id && canonicalDomainSecurityId(s.id) === canonical) return s;
  }
  const embedded = embeddedCatalogSecurities.get(canonical);
  if (embedded) return embedded;
  const normalized = normalizeRequestedSecurity(securityId);

  if (normalized) {
    return {
      id: securityId,
      displaySymbol: normalized.displaySymbol,
      name: normalized.displaySymbol,
      assetType:
        normalized.venueCode === "FUND" || normalized.venueCode === "USD_FUND"
          ? ("fund" as const)
          : normalized.venueCode === "INDEX"
          ? ("index" as const)
          : ("stock" as const),
      country: normalized.currency === "USD" ? ("US" as const) : ("JP" as const),
      exchangeMic: normalized.exchangeMic,
      currency: normalized.currency,
      exchangeLabel: normalized.exchangeMic,
    };
  }
  return undefined;
}


export function isTaxFreeAccount(account?: Seed["accounts"][number] | null): boolean {
  if (!account) return false;
  return account.accountType === "nisa_growth" || account.accountType === "nisa_tsumitate" || account.accountType === "nisa";
}

export function estimateNetDividend(grossAmount: number, currency: string, isTaxFree: boolean): number {
  return estimateNetDividendDecimal(grossAmount, currency, isTaxFree).toNumber();
}


const formatDividendAxisTick = (val: number, currency: "JPY" | "USD") => {
  if (val === 0) return currency === "JPY" ? "¥0" : "$0";
  if (currency === "JPY") {
    if (val >= 100_000_000) {
      const oku = val / 100_000_000;
      return `¥${oku % 1 === 0 ? oku : oku.toFixed(1)}億`;
    }
    if (val >= 10_000) {
      const man = val / 10_000;
      return `¥${man % 1 === 0 ? man : man.toFixed(1)}万`;
    }
    return `¥${Math.round(val).toLocaleString("ja-JP")}`;
  }
  // USD
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `$${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (val >= 1_000) {
    const k = val / 1_000;
    return `$${k % 1 === 0 ? k : k.toFixed(1)}K`;
  }
  if (val >= 1) {
    return `$${Math.round(val).toLocaleString("en-US")}`;
  }
  return `$${val.toFixed(2)}`;
};

const dividendSummaryNumber = new Intl.NumberFormat("ja-JP", {
  maximumSignificantDigits: 4,
  useGrouping: false,
});

export function formatDividendSummaryMoney(
  value: number,
  currency: "JPY" | "USD",
  dense = false,
) {
  const absolute = Math.abs(Number.isFinite(value) ? value : 0);
  const sign = value < 0 ? "−" : "";
  const symbol = currency === "JPY" ? "¥" : "$";
  const unit = (scale: number, suffix: string) =>
    `${sign}${symbol}${dividendSummaryNumber.format(absolute / scale)}${suffix}`;

  if (currency === "JPY") {
    if (absolute >= 1_000_000_000_000) return unit(1_000_000_000_000, "兆");
    if (absolute >= 100_000_000) return unit(100_000_000, "億");
    if (dense && absolute >= 10_000) return unit(10_000, "万");
  } else {
    if (absolute >= 1_000_000_000_000) return unit(1_000_000_000_000, "T");
    if (absolute >= 1_000_000_000) return unit(1_000_000_000, "B");
    if (absolute >= 1_000_000) return unit(1_000_000, "M");
    if (dense && absolute >= 1_000) return unit(1_000, "K");
  }

  return `${sign}${money(absolute, currency)}`;
}

export function MonthlyDividendLineChart({
  monthlyData,
  currency,
  amountsVisible,
  taxMode,
  selectedMonth,
  onSelectMonth,
}: {
  monthlyData: Array<{
    monthKey: string;
    monthLabel: string;
    gross: number;
    net: number;
    taxFree: number;
    taxable: number;
    count: number;
    securities: string[];
  }>;
  currency: "JPY" | "USD";
  amountsVisible: boolean;
  taxMode: "gross" | "net";
  selectedMonth: string | null;
  onSelectMonth: (month: string | null) => void;
}) {
  return (
    <LightweightLineChart
      data={monthlyData}
      xKey={(item) => item.monthKey}
      xLabel={(item) => item.monthLabel}
      yValue={(item) => (taxMode === "net" ? item.net : item.gross)}
      yTickFormatter={(val) => (amountsVisible ? formatDividendAxisTick(val, currency) : "")}
      valueFormatter={(val) => (amountsVisible ? formatDividendAxisTick(val, currency) : "")}
      tickCount={5}
      yAxisWidth={amountsVisible ? (currency === "JPY" ? 54 : 46) : 12}
      xAxisHeight={38}
      top={16}
      right={14}
      minHeight={170}
      showYAxis={amountsVisible}
      selectedKey={selectedMonth}
      onSelectItem={(item) => onSelectMonth(selectedMonth === item.monthKey ? null : item.monthKey)}
      tooltipContent={(item) => {
        const val = taxMode === "net" ? item.net : item.gross;
        const [y, m] = item.monthKey.split("-");
        const title = `${y}年${Number(m)}月`;
        return (
          <div className="chart-tooltip">
            <span>{title}</span>
            <div>
              <i style={{ background: "var(--accent)" }} />
              <small>{taxMode === "net" ? "税引後推計" : "税引前受取"}</small>
              <strong>{amountsVisible ? money(val, currency) : HIDDEN_AMOUNT}</strong>
            </div>
            {taxMode === "gross" && item.net > 0 && (
              <div>
                <i style={{ background: "var(--muted)" }} />
                <small>推計手取</small>
                <strong>{amountsVisible ? money(item.net, currency) : HIDDEN_AMOUNT}</strong>
              </div>
            )}

            {item.count > 0 && (
              <div>
                <i style={{ background: "var(--muted)" }} />
                <small>受取件数</small>
                <strong>{item.count}件</strong>
              </div>
            )}
            {item.securities.length > 0 && (
              <div style={{ marginTop: 4, fontSize: "9.5px", color: "var(--muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.securities.slice(0, 3).join(", ")}
                {item.securities.length > 3 ? ` 他${item.securities.length - 3}銘柄` : ""}
              </div>
            )}
          </div>
        );
      }}
      ariaLabel="月別受取実績データラインプロット"
    />
  );
}

export const MonthlyDividendBarChart = MonthlyDividendLineChart;




export function DividendsView({
  receipts,
  distributions,
  nativeDistributions = [],
  coverage = [],
  securityMap,
  accountMap,
  currency,
  displayCurrency: displayCurrencyProp,
  onDisplayCurrencyChange,
  marketFilter: marketFilterProp,
  onMarketFilterChange,
  period: periodProp,
  onPeriodChange,
  taxMode: taxModeProp,
  onTaxModeChange,
  activeTab: activeTabProp,
  onActiveTabChange,
  distributionStatus,
  distributionError,
  todayKey,
  amountsVisible,
  fxUnavailable = false,
  onSelectSecurity,
  onRefresh,
}: {
  receipts: DividendReceipt[];
  distributions: DistributionEvent[];
  nativeDistributions?: DistributionEvent[];
  coverage?: DistributionCoverage[];
  securityMap: Map<string, Seed["securities"][number] & { name?: string }>;
  accountMap: Map<string, Seed["accounts"][number]>;
  currency: "JPY" | "USD";
  displayCurrency?: DisplayCurrency;
  onDisplayCurrencyChange?: (currency: DisplayCurrency) => void;
  marketFilter?: PortfolioFilter;
  onMarketFilterChange?: (filter: PortfolioFilter) => void;
  period?: string;
  onPeriodChange?: (period: string) => void;
  taxMode?: "gross" | "net";
  onTaxModeChange?: (taxMode: "gross" | "net") => void;
  activeTab?: "securities" | "history";
  onActiveTabChange?: (tab: "securities" | "history") => void;
  distributionStatus: MarketStatus;
  distributionError: string;
  todayKey: string;
  amountsVisible: boolean;
  fxUnavailable?: boolean;
  onSelectSecurity?: (securityId: string) => void;
  onRefresh?: () => void;
}) {
  const preferenceStorage = useBrowserPreferences();
  const [internalPeriod, setInternalPeriod] = useState<string>(() => {
    if (typeof window === "undefined") return "ALL";
    return preferenceStorage.getItem(DIVIDEND_PERIOD_KEY) ?? "ALL";
  });
  const [internalAssetFilter, setInternalAssetFilter] = useState<PortfolioFilter>(() => {
    if (typeof window === "undefined") return "ALL";
    const saved = preferenceStorage.getItem(DIVIDEND_MARKET_FILTER_KEY) as PortfolioFilter | null;
    return saved === "ALL" || saved === "JP" || saved === "US" || saved === "FUNDS_INDEXES" ? saved : "ALL";
  });
  const [internalDisplayCurrency, setInternalDisplayCurrency] = useState<DisplayCurrency>(() => {
    if (typeof window === "undefined") return "JPY";
    const saved = preferenceStorage.getItem(DIVIDEND_DISPLAY_CURRENCY_KEY) as DisplayCurrency | null;
    return saved === "JPY" || saved === "USD" || saved === "NATIVE" ? saved : "JPY";
  });
  const [internalTaxMode, setInternalTaxMode] = useState<"gross" | "net">(() => {
    if (typeof window === "undefined") return "gross";
    const saved = preferenceStorage.getItem(DIVIDEND_TAX_MODE_KEY) as "gross" | "net" | null;
    return saved === "gross" || saved === "net" ? saved : "gross";
  });
  const [internalActiveTab, setInternalActiveTab] = useState<"securities" | "history">(() => {
    if (typeof window === "undefined") return "securities";
    const saved = preferenceStorage.getItem(DIVIDEND_TAB_KEY) as "securities" | "history" | null;
    return saved === "securities" || saved === "history" ? saved : "securities";
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string | null>(null);

  const period = periodProp ?? internalPeriod;
  const currentAssetFilter = marketFilterProp ?? internalAssetFilter;
  const displayCurrency = displayCurrencyProp ?? internalDisplayCurrency;
  const taxMode = taxModeProp ?? internalTaxMode;
  const activeTab = activeTabProp ?? internalActiveTab;

  const selectedSecurity = useMemo(() => {
    if (!selectedSecurityId) return null;
    return resolveSecurity(selectedSecurityId, securityMap);
  }, [securityMap, selectedSecurityId]);

  const selectedSecurityName = useMemo(() => {
    if (!selectedSecurity) return selectedSecurityId ?? "";
    return selectedSecurity.name ?? selectedSecurity.displaySymbol ?? selectedSecurityId;
  }, [selectedSecurity, selectedSecurityId]);

  const handlePeriodChange = (val: string) => {
    setInternalPeriod(val);
    preferenceStorage.setItem(DIVIDEND_PERIOD_KEY, val);
    onPeriodChange?.(val);
    setSelectedMonth(null);
  };

  const handleAssetFilterChange = (val: PortfolioFilter) => {
    setInternalAssetFilter(val);
    preferenceStorage.setItem(DIVIDEND_MARKET_FILTER_KEY, val);
    onMarketFilterChange?.(val);
    setSelectedSecurityId(null);
    setSelectedMonth(null);
  };

  const handleCurrencyChange = (val: DisplayCurrency) => {
    setInternalDisplayCurrency(val);
    preferenceStorage.setItem(DIVIDEND_DISPLAY_CURRENCY_KEY, val);
    onDisplayCurrencyChange?.(val);
  };

  const handleTaxModeChange = (val: "gross" | "net") => {
    setInternalTaxMode(val);
    preferenceStorage.setItem(DIVIDEND_TAX_MODE_KEY, val);
    onTaxModeChange?.(val);
  };

  const handleActiveTabChange = (val: "securities" | "history") => {
    setInternalActiveTab(val);
    preferenceStorage.setItem(DIVIDEND_TAB_KEY, val);
    onActiveTabChange?.(val);
  };

  const currentYear = todayKey.slice(0, 4);
  const trailingDate = new Date(`${todayKey}T00:00:00Z`);
  trailingDate.setUTCFullYear(trailingDate.getUTCFullYear() - 1);
  const trailingKey = trailingDate.toISOString().slice(0, 10);

  const availableYears = useMemo(() => {
    const years = new Set(receipts.map((r) => r.recognitionDate.slice(0, 4)));
    if (!years.has(currentYear)) years.add(currentYear);
    return [...years].sort((a, b) => b.localeCompare(a));
  }, [currentYear, receipts]);

  const assetReceipts = useMemo(() => {
    if (currentAssetFilter === "ALL") return receipts;
    return receipts.filter((receipt) => {
      const security = resolveSecurity(receipt.securityId, securityMap);
      return securityMatchesPortfolioFilter(security, currentAssetFilter, receipt.securityId);
    });
  }, [currentAssetFilter, receipts, securityMap]);

  const periodReceipts = useMemo(() => {
    return assetReceipts.filter((receipt) => {
      if (period === "LTM") return receipt.recognitionDate > trailingKey;
      if (period !== "ALL") return receipt.recognitionDate.startsWith(period);
      return true;
    });
  }, [assetReceipts, period, trailingKey]);

  const filteredReceipts = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return periodReceipts.filter((receipt) => {
      if (selectedMonth && !receipt.recognitionDate.startsWith(selectedMonth)) return false;
      if (selectedSecurityId && canonicalDomainSecurityId(receipt.securityId) !== canonicalDomainSecurityId(selectedSecurityId)) return false;
      if (query) {
        const security = resolveSecurity(receipt.securityId, securityMap);
        const account = accountMap.get(receipt.accountId);
        const text = `${security?.name ?? ""} ${security?.displaySymbol ?? ""} ${account?.name ?? ""} ${receipt.securityId}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
  }, [accountMap, periodReceipts, searchQuery, securityMap, selectedMonth, selectedSecurityId]);

  const sortedReceipts = useMemo(() => {
    return [...filteredReceipts].sort((left, right) =>
      right.recognitionDate === left.recognitionDate ? right.id.localeCompare(left.id) : right.recognitionDate.localeCompare(left.recognitionDate),
    );
  }, [filteredReceipts]);

  const nativeEventMap = useMemo(() => {
    const map = new Map<string, DistributionEvent>();
    for (const event of [...distributions, ...nativeDistributions]) {
      map.set(event.id, event);
    }
    return map;
  }, [distributions, nativeDistributions]);
  const sourceCurrencyFor = useCallback(
    (receipt: DividendReceipt) => receipt.sourceCurrency ?? nativeEventMap.get(receipt.distributionId)?.currency ?? receipt.currency,
    [nativeEventMap],
  );

  const convertedPeriodReceipts = periodReceipts.filter((receipt) => receipt.currency === currency);
  const totalGrossDecimal = convertedPeriodReceipts.reduce((sum, receipt) => sum.plus(receipt.grossAmount), new Decimal(0));
  const totalNetDecimal = convertedPeriodReceipts.reduce((sum, receipt) => sum.plus(estimateNetDividendDecimal(receipt.grossAmount, sourceCurrencyFor(receipt), isTaxFreeAccount(accountMap.get(receipt.accountId)))), new Decimal(0));
  const nisaReceipts = convertedPeriodReceipts.filter((receipt) => isTaxFreeAccount(accountMap.get(receipt.accountId)));
  const nisaGross = nisaReceipts.reduce((sum, receipt) => sum.plus(receipt.grossAmount), new Decimal(0));
  const nisaNet = nisaReceipts.reduce((sum, receipt) => sum.plus(estimateNetDividendDecimal(receipt.grossAmount, sourceCurrencyFor(receipt), true)), new Decimal(0));
  const totalGross = totalGrossDecimal.toNumber();
  const displayTotalDecimal = taxMode === "net" ? totalNetDecimal : totalGrossDecimal;
  const displayTotal = displayTotalDecimal.toNumber();
  const displayNisa = (taxMode === "net" ? nisaNet : nisaGross).toNumber();
  const displayTaxable = Decimal.max(0, taxMode === "net" ? totalNetDecimal.minus(nisaNet) : totalGrossDecimal.minus(nisaGross)).toNumber();
  const nisaRatio = totalGrossDecimal.gt(0) ? nisaGross.div(totalGrossDecimal).mul(100).toNumber() : 0;

  const securityTotals = useMemo(() => {
    const totals = new Map<string, { gross: Decimal; net: Decimal; count: number }>();
    for (const receipt of periodReceipts.filter((receipt) => receipt.currency === currency)) {
      const gross = new Decimal(receipt.grossAmount);
      const isTaxFree = isTaxFreeAccount(accountMap.get(receipt.accountId));
      const net = estimateNetDividendDecimal(gross, sourceCurrencyFor(receipt), isTaxFree);
      const entry = totals.get(receipt.securityId) ?? { gross: new Decimal(0), net: new Decimal(0), count: 0 };
      entry.gross = entry.gross.plus(gross);
      entry.net = entry.net.plus(net);
      entry.count += 1;
      totals.set(receipt.securityId, entry);
    }
    return [...totals].sort((a, b) => (taxMode === "net" ? b[1].net.comparedTo(a[1].net) : b[1].gross.comparedTo(a[1].gross))).map(([id, value]) => [id, { ...value, gross: value.gross.toNumber(), net: value.net.toNumber() }] as const);
  }, [accountMap, periodReceipts, sourceCurrencyFor, taxMode]);


  // Monthly Data for line plot
  const monthlyBarData = useMemo(() => {
    const months: string[] = [];
    const curY = Number(todayKey.slice(0, 4));
    const curM = Number(todayKey.slice(5, 7));

    if (period === "ALL") {
      const dates = assetReceipts.map((r) => r.recognitionDate).filter(Boolean).sort();
      const minYear = dates.length > 0 ? Number(dates[0].slice(0, 4)) : curY;
      const maxYear = curY;

      for (let y = minYear; y <= maxYear; y++) {
        const maxM = y === curY ? curM : 12;
        for (let m = 1; m <= maxM; m++) {
          months.push(`${y}-${String(m).padStart(2, "0")}`);
        }
      }
    } else if (period === "LTM") {
      for (let i = 11; i >= 0; i--) {
        const totalMonths = curY * 12 + (curM - 1) - i;
        const y = Math.floor(totalMonths / 12);
        const m = (totalMonths % 12) + 1;
        months.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    } else {
      const selectedYr = Number(period);
      const maxM = selectedYr === curY ? curM : selectedYr < curY ? 12 : 0;
      for (let m = 1; m <= maxM; m++) {
        months.push(`${period}-${String(m).padStart(2, "0")}`);
      }
    }

    const uniqueMonths = Array.from(new Set(months));

    const monthMap = new Map<string, { gross: Decimal; net: Decimal; taxFree: Decimal; taxable: Decimal; count: number; securities: Set<string> }>();
    for (const m of uniqueMonths) monthMap.set(m, { gross: new Decimal(0), net: new Decimal(0), taxFree: new Decimal(0), taxable: new Decimal(0), count: 0, securities: new Set() });

    for (const receipt of periodReceipts.filter((receipt) => receipt.currency === currency)) {
      const m = receipt.recognitionDate.slice(0, 7);
      const entry = monthMap.get(m);
      if (entry) {
        const gross = new Decimal(receipt.grossAmount);
        const isTaxFree = isTaxFreeAccount(accountMap.get(receipt.accountId));
        const net = estimateNetDividendDecimal(gross, sourceCurrencyFor(receipt), isTaxFree);
        entry.gross = entry.gross.plus(gross);
        entry.net = entry.net.plus(net);
        if (isTaxFree) entry.taxFree = entry.taxFree.plus(gross);
        else entry.taxable = entry.taxable.plus(gross);
        entry.count += 1;
        entry.securities.add(receipt.securityId);
      }
    }

    const isMultiYear = period === "ALL" && uniqueMonths.length > 12;

    return uniqueMonths.map((m) => {
      const entry = monthMap.get(m)!;
      const monthNum = Number(m.slice(5, 7));
      const yearShort = m.slice(2, 4);
      const monthLabel = isMultiYear
        ? monthNum === 1 || uniqueMonths.length <= 24
          ? `'${yearShort}/${monthNum}`
          : `${monthNum}月`
        : `${monthNum}月`;

      return {
        monthKey: m,
        monthLabel,
        gross: entry.gross.toNumber(),
        net: entry.net.toNumber(),
        taxFree: entry.taxFree.toNumber(),
        taxable: entry.taxable.toNumber(),
        count: entry.count,
        securities: [...entry.securities],
      };
    });
  }, [accountMap, assetReceipts, currentYear, period, periodReceipts, sourceCurrencyFor, todayKey]);

  const monthlyAverage = useMemo(() => {
    if (period === "LTM") return displayTotalDecimal.div(12).toNumber();
    if (period === "ALL") {
      const dates = assetReceipts.map((r) => r.recognitionDate).filter(Boolean).sort();
      if (!dates.length) return 0;
      const minM = Number(dates[0].slice(0, 4)) * 12 + Number(dates[0].slice(5, 7));
      const curM = Number(todayKey.slice(0, 4)) * 12 + Number(todayKey.slice(5, 7));
      const totalMonths = Math.max(1, curM - minM + 1);
      return displayTotalDecimal.div(totalMonths).toNumber();
    }
    const selectedYr = Number(period);
    const curYr = Number(todayKey.slice(0, 4));
    if (selectedYr === curYr) {
      const curM = Number(todayKey.slice(5, 7));
      return displayTotalDecimal.div(Math.max(1, curM)).toNumber();
    }
    return displayTotalDecimal.div(12).toNumber();
  }, [assetReceipts, displayTotal, period, todayKey]);

  return (
    <div className="dividends-page">
      {fxUnavailable && <p className="market-alert" role="status">為替レートがないため換算合計は未確定です。受取履歴には元の通貨を表示します。</p>}

      <section className="dividend-summary-wrap" aria-label="配当金サマリー">
        <div className="daily-summary dividend-summary" data-fx-unavailable={fxUnavailable}>
          <div className="dividend-summary-lead">
            <div className="dividend-summary-label-row">
              <span className="dividend-summary-label">
                {period === "ALL" ? "累計配当" : period === "LTM" ? "直近12か月" : `${period}年 配当`}
              </span>
              <span className="dividend-tax-tag">{taxMode === "net" ? "税引後" : "税引前"}</span>
            </div>
            <strong
              className="dividend-summary-value dividend-summary-total"
              aria-label={amountsVisible ? money(displayTotal, currency) : "金額非表示"}
              title={amountsVisible ? money(displayTotal, currency) : undefined}
            >
              {amountsVisible ? formatDividendSummaryMoney(displayTotal, currency) : HIDDEN_AMOUNT}
            </strong>
          </div>

          <div className="dividend-summary-support">
            <span className="dividend-summary-label">{period === "ALL" ? "年換算推計" : "月平均受取"}</span>
            <strong
              className="dividend-summary-value"
              aria-label={
                amountsVisible
                  ? money(period === "ALL" ? new Decimal(monthlyAverage).mul(12).toNumber() : monthlyAverage, currency)
                  : "金額非表示"
              }
              title={
                amountsVisible
                  ? money(period === "ALL" ? new Decimal(monthlyAverage).mul(12).toNumber() : monthlyAverage, currency)
                  : undefined
              }
            >
              {amountsVisible
                ? formatDividendSummaryMoney(period === "ALL" ? new Decimal(monthlyAverage).mul(12).toNumber() : monthlyAverage, currency, true)
                : HIDDEN_AMOUNT}
            </strong>
          </div>

          <div className="dividend-summary-divider" aria-hidden="true" />

          <dl className="dividend-summary-breakdown">
            <div className="dividend-summary-metric">
              <dt>NISA</dt>
              <dd>
                <strong
                  aria-label={amountsVisible ? money(displayNisa, currency) : "金額非表示"}
                  title={amountsVisible ? money(displayNisa, currency) : undefined}
                >
                  {amountsVisible ? formatDividendSummaryMoney(displayNisa, currency, true) : HIDDEN_AMOUNT}
                </strong>
                <small>{totalGross > 0 ? `非課税 · ${nisaRatio.toFixed(0)}%` : "非課税"}</small>
              </dd>
            </div>

            <div className="dividend-summary-metric">
              <dt>課税口座</dt>
              <dd>
                <strong
                  aria-label={amountsVisible ? money(displayTaxable, currency) : "金額非表示"}
                  title={amountsVisible ? money(displayTaxable, currency) : undefined}
                >
                  {amountsVisible ? formatDividendSummaryMoney(displayTaxable, currency, true) : HIDDEN_AMOUNT}
                </strong>
                <small>{totalGross > 0 ? `${(100 - nisaRatio).toFixed(0)}%` : "—"}</small>
              </dd>
            </div>

            <div className="dividend-summary-metric">
              <dt>受取実績</dt>
              <dd>
                <strong>{number.format(securityTotals.length)}銘柄</strong>
                <small>{number.format(periodReceipts.length)}回</small>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {distributionError && (
        <div className="market-alert" role="status">
          <AlertTriangle size={15} />
          <span>{distributionError}</span>
        </div>
      )}

      <section className="dividend-chart-card panel" aria-label="月別受取実績チャート">
        <div className="dividend-chart-body" data-swipe-ignore="true">
          <MonthlyDividendBarChart
            monthlyData={monthlyBarData}
            currency={currency}
            amountsVisible={amountsVisible}
            taxMode={taxMode}
            selectedMonth={selectedMonth}
            onSelectMonth={setSelectedMonth}
          />
        </div>
      </section>

      <section className="dividend-breakdown dividend-content-panel panel" aria-label="配当金詳細">
        <header className="dividend-panel-header">
          <div className="dividend-tab-nav" role="tablist" aria-label="配当金詳細表示切り替え">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "securities"}
              className={`dividend-tab-btn ${activeTab === "securities" ? "active" : ""}`}
              onClick={() => handleActiveTabChange("securities")}
            >
              銘柄別
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "history"}
              className={`dividend-tab-btn ${activeTab === "history" ? "active" : ""}`}
              onClick={() => handleActiveTabChange("history")}
            >
              受取履歴
            </button>
          </div>

          {activeTab === "history" && (
            <div className="dividend-ledger-header-tools">
              <div className="dividend-search-input">
                <Search size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <input
                  type="search"
                  placeholder="銘柄・口座で検索…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="受取履歴を検索"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="dividend-search-clear"
                    onClick={() => setSearchQuery("")}
                    aria-label="検索クリア"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}
        </header>

        {(selectedSecurityId || selectedMonth) && (
          <div className="dividend-filter-banner">
            <div className="dividend-filter-banner-left">
              {activeTab === "history" ? (
                <button
                  type="button"
                  className="dividend-filter-back-btn"
                  onClick={() => handleActiveTabChange("securities")}
                  title="銘柄別一覧に戻る"
                >
                  <ArrowLeft size={13} />
                  <span>銘柄別に戻る</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="dividend-filter-back-btn"
                  onClick={() => handleActiveTabChange("history")}
                  title="絞り込んだ受取履歴を表示"
                >
                  <span>履歴を表示</span>
                  <ArrowRight size={13} />
                </button>
              )}

              <div className="dividend-filter-chips">
                {selectedSecurityId && (
                  <span className="dividend-filter-chip">
                    <span className="dividend-filter-chip-label">銘柄:</span>
                    <strong className="dividend-filter-chip-val">{selectedSecurityName}</strong>
                    <button
                      type="button"
                      className="dividend-filter-chip-clear"
                      onClick={() => setSelectedSecurityId(null)}
                      title="この銘柄の絞り込みを解除"
                      aria-label="銘柄絞り込みを解除"
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}

                {selectedMonth && (
                  <span className="dividend-filter-chip">
                    <span className="dividend-filter-chip-label">対象月:</span>
                    <strong className="dividend-filter-chip-val">
                      {selectedMonth.slice(0, 4)}年{Number(selectedMonth.slice(5, 7))}月
                    </strong>
                    <button
                      type="button"
                      className="dividend-filter-chip-clear"
                      onClick={() => setSelectedMonth(null)}
                      title="対象月の絞り込みを解除"
                      aria-label="対象月絞り込みを解除"
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              className="dividend-filter-clear-all"
              onClick={() => {
                setSelectedSecurityId(null);
                setSelectedMonth(null);
              }}
              title="すべての絞り込みを解除して全件表示"
            >
              全件表示
            </button>
          </div>
        )}


        {activeTab === "securities" ? (
          <div className="dividend-breakdown-list">
            {securityTotals.length ? (
              securityTotals.map(([secId, stat]) => {
                const security = resolveSecurity(secId, securityMap);
                const assetBadge = securityAssetLabel(security, secId);
                const amount = taxMode === "net" ? stat.net : stat.gross;
                const ratio = displayTotal > 0 ? amount / displayTotal : 0;
                const isSelected = selectedSecurityId === secId || (selectedSecurityId != null && canonicalDomainSecurityId(selectedSecurityId) === canonicalDomainSecurityId(secId));
                return (
                  <div
                    className={`dividend-breakdown-row ${isSelected ? "active" : ""}`}
                    key={secId}
                    onClick={() => {
                      setSelectedSecurityId(isSelected ? null : secId);
                      if (!isSelected) handleActiveTabChange("history");
                    }}
                    title="クリックで受取履歴を表示"
                  >
                    <div>
                      <strong>{security?.name ?? security?.displaySymbol ?? secId}</strong>
                      <small>
                        {security?.displaySymbol ?? secId} · {assetBadge} · {stat.count}回
                      </small>
                      <div className="dividend-breakdown-bar">
                        <div className="dividend-breakdown-bar-fill" style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%` }} />
                      </div>
                    </div>
                    <div>
                      <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
                        {amountsVisible ? money(amount, currency) : HIDDEN_AMOUNT}
                      </strong>
                      <small>{(ratio * 100).toFixed(1)}%</small>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <Coins size={20} />
                <span>
                  {distributionStatus === "loading" || distributionStatus === "idle"
                    ? "分配履歴を取得中"
                    : "対象期間の配当金はありません"}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="dividend-table-wrap dividend-ledger">
            <table>
              <thead>
                <tr>
                  <th className="div-col-date">計上日</th>
                  <th className="div-col-sec">銘柄・口座</th>
                  <th className="div-col-qty">保有数量・単価</th>
                  <th className="div-col-amount">{taxMode === "net" ? "税引後推計" : "受取額"}</th>
                </tr>
              </thead>
              <tbody>
                {sortedReceipts.slice(0, 300).map((receipt) => {
                  const security = resolveSecurity(receipt.securityId, securityMap);
                  const assetBadge = securityAssetLabel(security, receipt.securityId);
                  const nativeEvent = nativeEventMap.get(receipt.distributionId);
                  const account = accountMap.get(receipt.accountId);
                  const isTaxFree = isTaxFreeAccount(account);
                  const gross = Number(receipt.grossAmount);
                  const net = estimateNetDividend(gross, sourceCurrencyFor(receipt), isTaxFree);
                  const displayAmount = taxMode === "net" ? net : gross;
                  const sourceLabel = receipt.confidence === "official" ? "公式" : receipt.confidence === "manual" ? "手入力" : "公開情報";
                  const unitAmount = nativeEvent?.amountPerUnit ?? receipt.amountPerUnit;
                  const unitCurrency = nativeEvent?.currency ?? receipt.currency;

                  return (
                    <tr
                      key={receipt.id}
                      onClick={() => onSelectSecurity?.(receipt.securityId)}
                      style={{ cursor: onSelectSecurity ? "pointer" : "default" }}
                    >
                      <td className="div-col-date">
                        <time>{dateJa(receipt.recognitionDate)}</time>
                        {receipt.entitlementDate !== receipt.recognitionDate && <small>権利 {dateJa(receipt.entitlementDate)}</small>}
                      </td>
                      <td className="div-col-sec">
                        <div className="div-sec-cell">
                          <strong title={security?.name ?? receipt.securityId}>{security?.name ?? security?.displaySymbol ?? receipt.securityId}</strong>
                          <small>
                            <span>{security?.displaySymbol ?? receipt.securityId}</span>
                            <span>·</span>
                            <span>{account?.name ?? receipt.accountId}</span>
                            <span className={`tax-badge ${isTaxFree ? "nisa" : "taxable"}`}>{isTaxFree ? "NISA" : "特定"}</span>
                            <span className="tax-badge asset">{assetBadge}</span>
                            <span className={`tax-badge source ${receipt.confidence}`}>{sourceLabel}</span>
                            {nativeEvent?.status === "estimated" && <span className="tax-badge estimated">推定</span>}
                          </small>
                        </div>
                      </td>
                      <td className="div-col-qty">
                        <strong>
                          {number.format(Number(receipt.eligibleQuantity))}
                          {securityQuantityUnit(security, receipt.securityId)}
                        </strong>
                        <small>
                          @{money(Number(unitAmount), unitCurrency)}
                          {Number(receipt.distributionUnit) !== 1 ? ` / ${number.format(Number(receipt.distributionUnit))}口` : ""}
                        </small>
                      </td>
                      <td className="div-col-amount" aria-label={amountsVisible ? undefined : "金額非表示"}>
                        <strong>{amountsVisible ? money(displayAmount, receipt.currency) : HIDDEN_AMOUNT}</strong>
                        {receipt.sourceCurrency && receipt.sourceCurrency !== currency && receipt.sourceGrossAmount && (
                          <small>
                            現地 {amountsVisible ? money(Number(receipt.sourceGrossAmount), receipt.sourceCurrency) : HIDDEN_AMOUNT}
                          </small>
                        )}
                        {taxMode === "gross" && !isTaxFree && (
                          <small>
                            推計手取 {amountsVisible ? money(net, receipt.currency) : HIDDEN_AMOUNT}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {!sortedReceipts.length && (
              <div className="empty-state">
                <Coins size={20} />
                <span>
                  {distributionStatus === "loading" || distributionStatus === "idle"
                    ? "分配履歴を取得中"
                    : searchQuery || selectedSecurityId || selectedMonth
                    ? "条件に一致する配当金はありません"
                    : "対象期間の配当金はありません"}
                </span>
                {(searchQuery || selectedSecurityId || selectedMonth) && (
                  <button
                    type="button"
                    className="dividend-filter-clear-all"
                    style={{ marginTop: "10px" }}
                    onClick={() => {
                      setSearchQuery("");
                      setSelectedSecurityId(null);
                      setSelectedMonth(null);
                    }}
                  >
                    絞り込みを解除して全件表示
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>


      {/* Floating Bottom Controls Dock matching overview, activity, watchlist, and notifications */}
      <div className="dividend-bottom-controls" data-swipe-ignore="true">
        <div className="segmented dividend-tax-segmented" role="tablist" aria-label="税区分表示">
          <button
            type="button"
            role="tab"
            aria-selected={taxMode === "gross"}
            className={taxMode === "gross" ? "active" : ""}
            onClick={() => handleTaxModeChange("gross")}
            title="税引前"
          >
            税前
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={taxMode === "net"}
            className={taxMode === "net" ? "active" : ""}
            onClick={() => handleTaxModeChange("net")}
            title="税引後推計"
          >
            税後
          </button>
        </div>

        <div className="dividend-filters" role="group" aria-label="配当金フィルター">
          <select
            aria-label="資産区分で絞り込み"
            className="dividend-filter-select"
            value={currentAssetFilter}
            onChange={(e) => handleAssetFilterChange(e.target.value as PortfolioFilter)}
          >
            <option value="ALL">全資産</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
            <option value="FUNDS_INDEXES">投信・指数</option>
          </select>
          <select
            aria-label="集計期間で絞り込み"
            className="dividend-filter-select"
            value={period}
            onChange={(e) => handlePeriodChange(e.target.value)}
          >
            <option value="ALL">全期間</option>
            <option value="LTM">直近12か月</option>
            {availableYears.map((yr) => (
              <option key={yr} value={yr}>
                {yr}年
              </option>
            ))}
          </select>
          <select
            aria-label="表示通貨"
            className="dividend-filter-select"
            value={displayCurrency}
            onChange={(e) => handleCurrencyChange(e.target.value as DisplayCurrency)}
          >
            <option value="JPY">JPY</option>
            <option value="USD">USD</option>
            <option value="NATIVE">現地通貨</option>
          </select>
        </div>
      </div>
    </div>
  );
}


export const FastDividendsView = memo(DividendsView);
