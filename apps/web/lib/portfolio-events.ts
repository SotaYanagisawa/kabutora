import type { SearchSecurity, Seed, UserPreferences } from "@/components/dashboard/types";
import { mergeLatestTransactions } from "./transaction-event-merge";
import { mergeLatestAccounts } from "./account-event-merge";
import { getPreferenceEventSequence } from "./preference-event-merge";
import { isPortfolioAccount, isPortfolioPreferences, isPortfolioSecurity, isPortfolioTransaction } from "./portfolio-validation";

type Stamp = { clientTimestamp?: string; clientSeq?: number; updatedAt?: string };
export type PortfolioEventPayload = Stamp & (
  | { kind: "transaction"; value: Seed["transactions"][number] }
  | { kind: "transaction-delete"; value: { id: string; deletedAt: string } }
  | { kind: "account"; value: Seed["accounts"][number] }
  | { kind: "security"; value: Seed["securities"][number] }
  | { kind: "watchlist"; value: SearchSecurity[] }
  | { kind: "preferences"; value: UserPreferences }
);
export type DecryptedPortfolioEvent = { id: string; payload: PortfolioEventPayload };

function retainUnchangedArray<T>(previous: T[], next: T[]) {
  if (previous === next || previous.length === next.length && previous.every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]))) return previous;
  return next;
}

export function validatePortfolioEvent(value: unknown): PortfolioEventPayload {
  const event = value as PortfolioEventPayload | null;
  const valid = event && (event.clientSeq === undefined || (Number.isSafeInteger(event.clientSeq) && event.clientSeq > 0)) && (
    (event.kind === "transaction" && isPortfolioTransaction(event.value)) ||
    (event.kind === "account" && isPortfolioAccount(event.value)) ||
    (event.kind === "security" && isPortfolioSecurity(event.value)) ||
    (event.kind === "watchlist" && Array.isArray(event.value) && event.value.every(isPortfolioSecurity)) ||
    (event.kind === "preferences" && isPortfolioPreferences(event.value)) ||
    (event.kind === "transaction-delete" && event.value && typeof event.value.id === "string" && Number.isFinite(Date.parse(event.value.deletedAt)))
  );
  if (!valid) throw new Error("同期データの内容を検証できませんでした。未反映の変更は保持されています。");
  return event;
}

/** Deterministic replay, including tombstones and per-setting clocks across compaction. */
export function replayPortfolioEvents(base: Seed, events: DecryptedPortfolioEvent[]): Seed {
  const applied = new Set(base.sync?.appliedEventIds ?? []);
  const pending = events.filter((event) => !applied.has(event.id)).sort((a, b) => getPreferenceEventSequence(a.payload) - getPreferenceEventSequence(b.payload) || a.id.localeCompare(b.id));
  if (!pending.length) return base;
  let transactions = base.transactions;
  let accounts = base.accounts;
  let securitiesModified = false;
  const securities = new Map(base.securities.map((security) => [security.id, security]));
  const deleted = { ...base.sync?.deletedTransactions };
  const preferenceSequences = { ...base.sync?.preferenceSequences };
  const basePreferenceSequence = getPreferenceEventSequence({ value: base.preferences });
  for (const key of Object.keys(base.preferences ?? {})) preferenceSequences[key] ??= basePreferenceSequence;
  let watchlistSequence = base.sync?.watchlistSequence ?? 0;
  let watchlist = base.watchlist;
  const preferences: UserPreferences = { ...base.preferences };
  for (const { id, payload: event } of pending) {
    const sequence = getPreferenceEventSequence(event);
    switch (event.kind) {
      case "transaction":
        if (!(event.value.id in deleted) || sequence > deleted[event.value.id]!) {
          delete deleted[event.value.id];
          transactions = mergeLatestTransactions(transactions, [event.value]);
        }
        break;
      case "transaction-delete":
        if (sequence >= (deleted[event.value.id] ?? 0)) {
          const transaction = transactions.find((item) => item.id === event.value.id);
          if (!transaction || sequence >= (Date.parse(transaction.updatedAt) || 0)) {
            deleted[event.value.id] = sequence;
            transactions = transactions.filter((item) => item.id !== event.value.id);
          }
        }
        break;
      case "account": accounts = mergeLatestAccounts(accounts, [event.value]); break;
      case "security": securities.set(event.value.id, event.value); securitiesModified = true; break;
      case "watchlist": if (sequence >= watchlistSequence) { watchlist = event.value; watchlistSequence = sequence; } break;
      case "preferences":
        for (const [key, value] of Object.entries(event.value)) {
          if (key === "preferenceSequences") continue;
          const fieldSequence = event.value.preferenceSequences?.[key] ?? sequence;
          if (key === "readNotifications" || key === "acknowledgedActions") {
            preferences[key] = [...new Set([...(preferences[key] ?? []), ...(value as string[])])];
          } else if (fieldSequence >= (preferenceSequences[key] ?? 0)) {
            Object.assign(preferences, { [key]: value });
            preferenceSequences[key] = fieldSequence;
          }
        }
        break;
    }
    applied.add(id);
  }
  const nextSecurities = securitiesModified ? [...securities.values()] : base.securities;
  return {
    ...base,
    transactions: retainUnchangedArray(base.transactions, transactions),
    accounts: retainUnchangedArray(base.accounts, accounts),
    securities: retainUnchangedArray(base.securities, nextSecurities),
    preferences,
    ...(watchlist ? { watchlist: retainUnchangedArray(base.watchlist ?? [], watchlist) } : {}),
    sync: { appliedEventIds: [...applied], deletedTransactions: deleted, preferenceSequences, watchlistSequence },
  };
}
