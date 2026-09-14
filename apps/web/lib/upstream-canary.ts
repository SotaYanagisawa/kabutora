import { getTokyoQuoteBundle, getUsQuoteBundleWithFallback } from "./server-market-provider";
import { getYahooJapanFundQuoteBundle } from "./yahoo-japan-fund";
import type { MarketQuote } from "@kabutora/domain";

export type UpstreamCanaryTarget = "tse_stock" | "us_equity" | "japan_fund";

export type UpstreamCanaryCheck = {
  target: UpstreamCanaryTarget;
  symbol: string;
  provider?: string;
  ok: boolean;
  driftDetected: boolean;
  latencyMs: number;
  price?: string;
  error?: string;
  driftReasons?: string[];
};

export type UpstreamCanaryReport = {
  timestamp: string;
  allPassed: boolean;
  driftDetected: boolean;
  checks: UpstreamCanaryCheck[];
  summary: string;
};

export type CanaryDependencies = {
  fetchTokyoQuote?: typeof getTokyoQuoteBundle;
  fetchUsQuote?: typeof getUsQuoteBundleWithFallback;
  fetchFundQuote?: typeof getYahooJapanFundQuoteBundle;
};

const CANARY_SYMBOLS = {
  tse_stock: { symbol: "7203.T", securityId: "sec-jp-7203", venueCode: "TSE" },
  us_equity: { symbol: "SPY", securityId: "sec-us-spy", venueCode: "US" },
  japan_fund: { symbol: "0331418A", securityId: "sec-jp-fund-0331418a", venueCode: "FUND" },
} as const;

function isFinitePositive(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}

function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export function validateCanaryQuote(
  target: UpstreamCanaryTarget,
  quote: Partial<MarketQuote> | null | undefined,
): { valid: boolean; driftReasons: string[] } {
  const driftReasons: string[] = [];
  if (!quote) {
    return { valid: false, driftReasons: ["Quote object is null or undefined"] };
  }

  if (!isFinitePositive(quote.price)) {
    driftReasons.push(`Invalid price: ${String(quote.price)}`);
  }

  if (!isValidIsoTimestamp(quote.marketTimestamp)) {
    driftReasons.push(`Invalid marketTimestamp: ${String(quote.marketTimestamp)}`);
  }

  if (!quote.validationStatus || !["valid", "suspect"].includes(quote.validationStatus)) {
    driftReasons.push(`Invalid validationStatus: ${String(quote.validationStatus)}`);
  }

  if (target === "tse_stock") {
    if (quote.venueCode !== "TSE") driftReasons.push(`Expected venueCode TSE, got ${String(quote.venueCode)}`);
  } else if (target === "us_equity") {
    if (quote.venueCode !== "US" && quote.venueCode !== "AMEX" && quote.venueCode !== "NASDAQ" && quote.venueCode !== "NYSE") {
      driftReasons.push(`Expected US venueCode, got ${String(quote.venueCode)}`);
    }
  } else if (target === "japan_fund") {
    if (quote.venueCode !== "FUND") driftReasons.push(`Expected venueCode FUND, got ${String(quote.venueCode)}`);
    if (quote.previousRegularClose && !isFinitePositive(quote.previousRegularClose)) {
      driftReasons.push(`Invalid previousRegularClose: ${String(quote.previousRegularClose)}`);
    }
  }

  return { valid: driftReasons.length === 0, driftReasons };
}

export async function runUpstreamCanary(
  deps: CanaryDependencies = {},
): Promise<UpstreamCanaryReport> {
  const timestamp = new Date().toISOString();
  const fetchTokyo = deps.fetchTokyoQuote ?? getTokyoQuoteBundle;
  const fetchUs = deps.fetchUsQuote ?? getUsQuoteBundleWithFallback;
  const fetchFund = deps.fetchFundQuote ?? getYahooJapanFundQuoteBundle;

  const checks: UpstreamCanaryCheck[] = [];

  // Check 1: TSE Stock (7203.T)
  const tseStart = Date.now();
  try {
    const bundle = await fetchTokyo(CANARY_SYMBOLS.tse_stock.symbol, CANARY_SYMBOLS.tse_stock.securityId, true, "1d");
    const { valid, driftReasons } = validateCanaryQuote("tse_stock", bundle.quote);
    checks.push({
      target: "tse_stock",
      symbol: CANARY_SYMBOLS.tse_stock.symbol,
      provider: bundle.quote.provider,
      ok: valid,
      driftDetected: !valid,
      latencyMs: Date.now() - tseStart,
      price: bundle.quote.price,
      ...(driftReasons.length ? { driftReasons } : {}),
    });
  } catch (cause) {
    checks.push({
      target: "tse_stock",
      symbol: CANARY_SYMBOLS.tse_stock.symbol,
      ok: false,
      driftDetected: true,
      latencyMs: Date.now() - tseStart,
      error: cause instanceof Error ? cause.message : String(cause),
      driftReasons: ["Request failed or parser threw an exception"],
    });
  }

  // Check 2: US Equity (SPY)
  const usStart = Date.now();
  try {
    const bundle = await fetchUs(CANARY_SYMBOLS.us_equity.symbol, CANARY_SYMBOLS.us_equity.securityId, "US", true, "1d");
    const { valid, driftReasons } = validateCanaryQuote("us_equity", bundle.quote);
    checks.push({
      target: "us_equity",
      symbol: CANARY_SYMBOLS.us_equity.symbol,
      provider: bundle.quote.provider,
      ok: valid,
      driftDetected: !valid,
      latencyMs: Date.now() - usStart,
      price: bundle.quote.price,
      ...(driftReasons.length ? { driftReasons } : {}),
    });
  } catch (cause) {
    checks.push({
      target: "us_equity",
      symbol: CANARY_SYMBOLS.us_equity.symbol,
      ok: false,
      driftDetected: true,
      latencyMs: Date.now() - usStart,
      error: cause instanceof Error ? cause.message : String(cause),
      driftReasons: ["Request failed or parser threw an exception"],
    });
  }

  // Check 3: Japanese Mutual Fund (0331418A)
  const fundStart = Date.now();
  try {
    const bundle = await fetchFund(CANARY_SYMBOLS.japan_fund.symbol, CANARY_SYMBOLS.japan_fund.securityId, true);
    const { valid, driftReasons } = validateCanaryQuote("japan_fund", bundle.quote);
    checks.push({
      target: "japan_fund",
      symbol: CANARY_SYMBOLS.japan_fund.symbol,
      provider: bundle.quote.provider,
      ok: valid,
      driftDetected: !valid,
      latencyMs: Date.now() - fundStart,
      price: bundle.quote.price,
      ...(driftReasons.length ? { driftReasons } : {}),
    });
  } catch (cause) {
    checks.push({
      target: "japan_fund",
      symbol: CANARY_SYMBOLS.japan_fund.symbol,
      ok: false,
      driftDetected: true,
      latencyMs: Date.now() - fundStart,
      error: cause instanceof Error ? cause.message : String(cause),
      driftReasons: ["Request failed or parser threw an exception"],
    });
  }

  const allPassed = checks.every((c) => c.ok);
  const driftDetected = checks.some((c) => c.driftDetected);
  const summary = allPassed
    ? "All upstream canary targets valid and responding normally"
    : `Upstream schema drift or failure detected in: ${checks.filter((c) => !c.ok).map((c) => c.symbol).join(", ")}`;

  return {
    timestamp,
    allPassed,
    driftDetected,
    checks,
    summary,
  };
}
