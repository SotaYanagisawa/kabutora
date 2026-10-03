"use client";

import { earliestHistoryDate } from "@/lib/market/market-history";
import { parseDecimalInput } from "@/lib/portfolio/decimal-input";
import { localDateInputValue } from "@/lib/ui/calendar-time";
import type { MarketBar } from "@kabutora/domain";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { securityPriceUnit } from "./helpers";
import type { DashboardProps, SearchSecurity, Seed, View } from "./types";

type Transaction = Seed["transactions"][number];
type Account = Seed["accounts"][number];
const CASH_BROKER = "現金口座";
/** Sentinel account ID meaning "create an account for the typed broker". */
export const CUSTOM_ACCOUNT_ID = "__custom__";

const defaultAccountId = (accounts: Account[]) =>
  accounts.find((account) => account.broker !== CASH_BROKER && !account.archivedAt)?.id ?? accounts.find((account) => !account.archivedAt)?.id;

type Options = Pick<DashboardProps, "onTransactionsChange" | "onAccountsChange"> & {
  portfolioId: string;
  transactions: Transaction[];
  setTransactions: (next: Transaction[]) => void;
  accounts: Account[];
  setAccounts: (next: Account[]) => void;
  accountMap: ReadonlyMap<string, Account>;
  activeAccounts: Account[];
  securityMap: ReadonlyMap<string, SearchSecurity & { priceUnit?: string }>;
  rememberSecurity: (security: SearchSecurity) => void;
  initialSecurityId: string;
  historyBars: MarketBar[];
  requestHistoryReload: () => void;
  view: View;
  detailSecurityId: string;
  navigateToView: (view: View) => void;
  showToast: (message: string) => void;
};

/** Trade entry/edit modal, transaction deletion and account removal. */
export function useTradeEditor({
  portfolioId, transactions, setTransactions, accounts, setAccounts, accountMap, activeAccounts, securityMap, rememberSecurity, initialSecurityId,
  historyBars, requestHistoryReload, view, detailSecurityId, navigateToView, showToast, onTransactionsChange, onAccountsChange,
}: Options) {
  const [tradeOpen, setTradeOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [pendingDeleteTransaction, setPendingDeleteTransaction] = useState<Transaction | null>(null);
  const [pendingRemoveAccountId, setPendingRemoveAccountId] = useState<string | null>(null);
  const [selectedSecurity, setSelectedSecurity] = useState(initialSecurityId);
  const [tradeType, setTradeType] = useState<"BUY" | "SELL">("BUY");
  const [tradeQuantity, setTradeQuantity] = useState("");
  const [tradePrice, setTradePrice] = useState("");
  const [tradeDate, setTradeDate] = useState(() => localDateInputValue());
  const [selectedAccountId, setSelectedAccountId] = useState(accounts.find((account) => account.broker !== CASH_BROKER)?.id ?? accounts[0]?.id ?? "");
  const [customBroker, setCustomBroker] = useState("");
  const [tradeSearchActive, setTradeSearchActive] = useState(false);

  // Keep a valid account selected (an archived account stays selectable only while editing its trade).
  useEffect(() => {
    if (selectedAccountId === CUSTOM_ACCOUNT_ID || accounts.some((account) => account.id === selectedAccountId && (!account.archivedAt || editingTransaction?.accountId === account.id))) return;
    setSelectedAccountId(defaultAccountId(accounts) ?? "");
  }, [accounts, editingTransaction, selectedAccountId]);

  const editingAccount = editingTransaction ? accountMap.get(editingTransaction.accountId) : undefined;
  const selectableAccounts = editingAccount?.archivedAt && !activeAccounts.some((account) => account.id === editingAccount.id) ? [...activeAccounts, editingAccount] : activeAccounts;
  const selectedTradeSecurity = securityMap.get(selectedSecurity);
  const parsedTradeQuantity = parseDecimalInput(tradeQuantity);
  const parsedTradePrice = parseDecimalInput(tradePrice);
  const validTradeAmounts = Boolean(parsedTradeQuantity?.gt(0) && parsedTradePrice?.gte(0));
  const tradePreview = validTradeAmounts ? parsedTradeQuantity!.mul(parsedTradePrice!).div(securityPriceUnit(selectedTradeSecurity)) : null;

  const resetDraft = () => {
    setTradeSearchActive(false);
    setCustomBroker("");
  };

  const closeTradeModal = useCallback(() => {
    setTradeOpen(false);
    setEditingTransaction(null);
    resetDraft();
  }, []);

  const openNewTrade = useCallback(() => {
    setEditingTransaction(null);
    setTradeType("BUY");
    setTradeDate(localDateInputValue());
    setTradeQuantity("");
    setTradePrice("");
    resetDraft();
    setTradeOpen(true);
  }, []);

  const requestTransactionEdit = useCallback((transactionId: string) => {
    const transaction = transactions.find((item) => item.id === transactionId);
    if (!transaction || !transaction.securityId || (transaction.type !== "BUY" && transaction.type !== "SELL")) return;
    setEditingTransaction(transaction);
    setTradeType(transaction.type);
    setTradeDate(transaction.tradeDate.slice(0, 10));
    setTradeQuantity(String(transaction.quantity ?? "").replace(/^-/, ""));
    setTradePrice(String(transaction.pricePerShare ?? "").replace(/^-/, ""));
    setSelectedSecurity(transaction.securityId);
    setSelectedAccountId(transaction.accountId);
    resetDraft();
    setTradeOpen(true);
  }, [transactions]);

  const requestTransactionDelete = useCallback((transactionId: string) => {
    const transaction = transactions.find((item) => item.id === transactionId);
    if (transaction) setPendingDeleteTransaction(transaction);
  }, [transactions]);

  /** Leaves a detail page whose security no longer has any transactions. */
  const leaveEmptyDetail = (next: Transaction[]) => {
    if (view === "security" && !next.some((transaction) => transaction.securityId === detailSecurityId)) navigateToView("overview");
  };

  const confirmTransactionDelete = () => {
    if (!pendingDeleteTransaction) return;
    const deleted = pendingDeleteTransaction;
    const next = transactions.filter((transaction) => transaction.id !== deleted.id);
    setTransactions(next);
    setPendingDeleteTransaction(null);
    if (deleted.securityId === detailSecurityId) leaveEmptyDetail(next);
    void onTransactionsChange?.(next);
    showToast("取引を削除し、損益を再計算しました");
  };

  const confirmAccountRemoval = () => {
    if (!pendingRemoveAccountId) return;
    const target = accountMap.get(pendingRemoveAccountId);
    if (!target) return setPendingRemoveAccountId(null);
    const now = new Date().toISOString();
    const next = accounts.map((account) => account.id === target.id ? { ...account, archivedAt: now, updatedAt: now, version: Number(account.version ?? 1) + 1 } : account);
    setAccounts(next);
    setSelectedAccountId(defaultAccountId(next) ?? CUSTOM_ACCOUNT_ID);
    setPendingRemoveAccountId(null);
    void onAccountsChange?.(next);
    showToast(`${target.name}を取引口座一覧から削除しました`);
  };

  /** Selects a security for the trade form, switching to an account in its currency when needed. */
  const selectTradeSecurity = useCallback((security: SearchSecurity) => {
    rememberSecurity(security);
    setSelectedSecurity(security.id);
    const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
    if (selectedAccount?.defaultCurrency && selectedAccount.defaultCurrency !== security.currency) {
      const matchingAccount = activeAccounts.find((account) => account.defaultCurrency === security.currency && account.broker !== CASH_BROKER);
      if (matchingAccount) setSelectedAccountId(matchingAccount.id);
    }
  }, [activeAccounts, rememberSecurity, selectedAccountId]);

  const openTradeForSecurity = useCallback((security: SearchSecurity) => {
    selectTradeSecurity(security);
    setTradeOpen(true);
  }, [selectTradeSecurity]);

  const submitTrade = (event: FormEvent) => {
    event.preventDefault();
    if (!validTradeAmounts || !parsedTradeQuantity || !parsedTradePrice || !tradePreview || !Number.isFinite(tradePreview.toNumber())) return;
    const security = securityMap.get(selectedSecurity);
    if (!security) return;
    let account = selectableAccounts.find((item) => item.id === selectedAccountId);
    if (selectedAccountId === CUSTOM_ACCOUNT_ID) {
      const broker = customBroker.trim();
      if (!broker) return;
      account = activeAccounts.find((item) => item.broker.toLocaleLowerCase("ja") === broker.toLocaleLowerCase("ja"));
      if (!account) {
        account = { id: `account-${crypto.randomUUID()}`, name: `${broker} ${security.currency === "USD" ? "米国株" : "特定"}`, broker, accountType: "taxable", country: security.currency === "USD" ? "US" : "JP", defaultCurrency: security.currency };
        const nextAccounts = [...accounts, account];
        setAccounts(nextAccounts);
        setSelectedAccountId(account.id);
        void onAccountsChange?.(nextAccounts);
      }
    }
    if (!account) return;
    const amount = parsedTradeQuantity.mul(parsedTradePrice).div(securityPriceUnit(security)).toString();
    const now = new Date().toISOString();
    const recordedTradeDate = tradeDate || now.slice(0, 10);
    const original = { broker: account.broker, nisa: account.accountType === "nisa" ? "Y" : "N", action: tradeType };
    const fields = { accountId: account.id, securityId: security.id, type: tradeType, tradeDate: recordedTradeDate, quantity: parsedTradeQuantity.toString(), pricePerShare: parsedTradePrice.toString(), tradeCurrency: security.currency, grossAmount: amount };
    const transaction = editingTransaction
      ? { ...editingTransaction, ...fields, original: { ...editingTransaction.original, ...original }, updatedAt: now, version: Number(editingTransaction.version ?? 1) + 1 } satisfies Transaction
      : { id: `trade-${crypto.randomUUID()}`, portfolioId, ...fields, source: "manual", original: { ...original, row: 0 }, createdAt: now, updatedAt: now, version: 1 } satisfies Transaction;
    const next = editingTransaction ? transactions.map((item) => item.id === editingTransaction.id ? transaction : item) : [...transactions, transaction];
    setTransactions(next);
    if (editingTransaction?.securityId === detailSecurityId && security.id !== detailSecurityId) leaveEmptyDetail(next);
    const coveredFrom = earliestHistoryDate(historyBars, security.id);
    if (!coveredFrom || recordedTradeDate < coveredFrom) requestHistoryReload();
    void onTransactionsChange?.(next);
    closeTradeModal();
    setTradeQuantity("");
    setTradePrice("");
    setTradeDate(localDateInputValue());
    showToast(`${security.displaySymbol} ${tradeType === "BUY" ? "買付" : "売却"}を${editingTransaction ? "更新" : "保存"}`);
  };

  return {
    openNewTrade, openTradeForSecurity, requestTransactionEdit, requestTransactionDelete,
    tradeModalProps: {
      isOpen: tradeOpen, editingTransaction, tradeType, setTradeType, selectedTradeSecurity, selectTradeSecurity, tradeSearchActive, setTradeSearchActive,
      selectedAccountId, setSelectedAccountId, selectableAccounts, customBroker, setCustomBroker, tradeDate, setTradeDate,
      tradeQuantity, setTradeQuantity, tradePrice, setTradePrice, tradePreview, onSubmit: submitTrade, onClose: closeTradeModal, onOpenRemoveAccount: setPendingRemoveAccountId,
    },
    deleteDialogProps: { transaction: pendingDeleteTransaction, onConfirm: confirmTransactionDelete, onCancel: () => setPendingDeleteTransaction(null) },
    removeAccountDialogProps: { accountId: pendingRemoveAccountId, onConfirm: confirmAccountRemoval, onCancel: () => setPendingRemoveAccountId(null) },
  };
}
