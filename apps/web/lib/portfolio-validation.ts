import type { Seed, UserPreferences } from "@/components/dashboard/types";
import { finiteDecimal, isDateValue, isRecord, isText } from "./validation-primitives";
export { finiteDecimal } from "./validation-primitives";

const object = isRecord;
const text = (value: unknown) => isText(value);
const id = (value: unknown) => isText(value, 1);
const sequence = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sequenceMap = (value: unknown) => object(value) && Object.values(value).every(sequence);
const date = isDateValue;
export const isPortfolioSecurity = (value: unknown): value is Seed["securities"][number] => object(value)
  && [value.id, value.displaySymbol, value.name, value.exchangeMic, value.currency].every(id)
  && object(value.providerSymbols) && Object.values(value.providerSymbols).every(text)
  && (value.priceUnit === undefined || finiteDecimal(value.priceUnit, true));
export const isPortfolioAccount = (value: unknown): value is Seed["accounts"][number] => object(value)
  && [value.id, value.name, value.broker, value.accountType].every(id)
  && (value.version === undefined || (Number.isSafeInteger(value.version) && Number(value.version) >= 0));
export const isPortfolioTransaction = (value: unknown): value is Seed["transactions"][number] => object(value)
  && [value.id, value.accountId, value.portfolioId, value.tradeCurrency].every(id)
  && (value.securityId === null || id(value.securityId)) && ["BUY", "SELL", "TRANSFER_IN", "DIVIDEND"].includes(String(value.type))
  && typeof value.tradeDate === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/u.test(value.tradeDate) && Number.isFinite(Date.parse(value.tradeDate))
  && [value.quantity, value.pricePerShare, value.grossAmount].every((amount) => amount === null || finiteDecimal(amount))
  && (value.original === undefined || (object(value.original) && [value.original.broker, value.original.nisa, value.original.action].every((item) => item == null || text(item)) && (value.original.row === undefined || sequence(value.original.row))))
  && Number.isSafeInteger(value.version) && Number(value.version) >= 0 && text(value.updatedAt) && text(value.createdAt);

export function isPortfolioPreferences(value: unknown): value is UserPreferences {
  if (!object(value)) return false;
  const choices: Record<string, unknown[]> = {
    theme: ["light", "dark"], accentTheme: ["graphite", "blue", "forest", "plum"], displayCurrency: ["JPY", "USD", "NATIVE"],
    dividendDisplayCurrency: ["JPY", "USD", "NATIVE"], summaryMarketFilter: ["ALL", "JP", "US", "FUNDS_INDEXES"],
    dividendMarketFilter: ["ALL", "JP", "US", "FUNDS_INDEXES"], updateFrequency: [10, 15, 30, 60], dividendTaxMode: ["gross", "net"],
    dividendActiveTab: ["securities", "history"], summaryRange: ["1D", "1W", "1M", "3M", "YTD", "ALL", "CUSTOM"],
  };
  for (const [key, allowed] of Object.entries(choices)) if (value[key] !== undefined && !allowed.includes(value[key])) return false;
  for (const key of ["autoRefresh", "summaryAmountsVisible", "hideScrollbar"]) if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  for (const key of ["readNotifications", "acknowledgedActions"]) if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(text))) return false;
  if (value.lastUsdJpy !== undefined && (typeof value.lastUsdJpy !== "number" || !Number.isFinite(value.lastUsdJpy) || value.lastUsdJpy <= 0)) return false;
  if (value.priceAlertThreshold !== undefined && (typeof value.priceAlertThreshold !== "number" || !Number.isFinite(value.priceAlertThreshold) || value.priceAlertThreshold <= 0)) return false;
  if (value.summaryBrokerFilter !== undefined && !text(value.summaryBrokerFilter)) return false;
  if (value.dividendPeriod !== undefined && !text(value.dividendPeriod)) return false;
  if (value.summaryCustomRange != null && (!object(value.summaryCustomRange) || !date(value.summaryCustomRange.from) || !date(value.summaryCustomRange.to))) return false;
  if (value.notificationHistory !== undefined && (!Array.isArray(value.notificationHistory) || !value.notificationHistory.every((item) => object(item) && [item.id, item.securityId, item.type, item.title].every(id) && date(item.occurredAt)))) return false;
  if (value.preferenceSequences !== undefined && !sequenceMap(value.preferenceSequences)) return false;
  return true;
}

export function validatePortfolio(value: unknown): Seed {
  if (!object(value) || !object(value.portfolio) || ![value.portfolio.id, value.portfolio.name, value.portfolio.baseCurrency, value.portfolio.defaultCostBasisMethod].every(id)
    || !Array.isArray(value.transactions) || !value.transactions.every(isPortfolioTransaction)
    || !Array.isArray(value.accounts) || !value.accounts.every(isPortfolioAccount)
    || !Array.isArray(value.securities) || !value.securities.every(isPortfolioSecurity)
    || (value.watchlist !== undefined && (!Array.isArray(value.watchlist) || !value.watchlist.every(isPortfolioSecurity)))
    || (value.preferences !== undefined && !isPortfolioPreferences(value.preferences))
    || !Array.isArray(value.importWarnings)
    || (value.sync !== undefined && (!object(value.sync) || !Array.isArray(value.sync.appliedEventIds) || !value.sync.appliedEventIds.every(id)
      || (value.sync.deletedTransactions !== undefined && !sequenceMap(value.sync.deletedTransactions))
      || (value.sync.preferenceSequences !== undefined && !sequenceMap(value.sync.preferenceSequences))
      || (value.sync.watchlistSequence !== undefined && !sequence(value.sync.watchlistSequence))))) {
    throw new Error("ポートフォリオの内容を検証できませんでした。元の暗号化データは保持されています。");
  }
  return value as Seed;
}
