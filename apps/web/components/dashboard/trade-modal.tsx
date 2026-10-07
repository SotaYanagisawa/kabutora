"use client";

import type React from "react";
import { X, Trash2, ShieldCheck } from "lucide-react";
import SecuritySearchField from "../search/security-search-field";
import { useModalFocus } from "./use-modal-focus";
import { localDateInputValue } from "@/lib/ui/calendar-time";
import {
  isFundSecurity,
  isIndexSecurity,
  money,
  securityPriceBasis,
  securityPriceUnit,
} from "./helpers";
import type { SearchSecurity, Seed } from "./types";

export type TradeModalProps = {
  isOpen: boolean;
  editingTransaction: Seed["transactions"][number] | null;
  tradeType: "BUY" | "SELL";
  setTradeType: (type: "BUY" | "SELL") => void;
  nativeMarketSecurities: SearchSecurity[];
  selectedTradeSecurity: SearchSecurity | undefined;
  selectTradeSecurity: (security: SearchSecurity) => void;
  tradeSearchActive: boolean;
  setTradeSearchActive: (active: boolean) => void;
  handleSearchNetworkRequest?: () => void;
  selectedAccountId: string;
  setSelectedAccountId: (id: string) => void;
  selectableAccounts: Seed["accounts"];
  accountMap: Map<string, Seed["accounts"][number]>;
  customBroker: string;
  setCustomBroker: (broker: string) => void;
  tradeDate: string;
  setTradeDate: (date: string) => void;
  tradeQuantity: string;
  setTradeQuantity: (qty: string) => void;
  tradePrice: string;
  setTradePrice: (price: string) => void;
  tradePreview: number | null;
  persistenceMode?: string;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
  onOpenRemoveAccount: (accountId: string) => void;
};

export function TradeModal({
  isOpen,
  editingTransaction,
  tradeType,
  setTradeType,
  nativeMarketSecurities,
  selectedTradeSecurity,
  selectTradeSecurity,
  tradeSearchActive,
  setTradeSearchActive,
  handleSearchNetworkRequest,
  selectedAccountId,
  setSelectedAccountId,
  selectableAccounts,
  accountMap,
  customBroker,
  setCustomBroker,
  tradeDate,
  setTradeDate,
  tradeQuantity,
  setTradeQuantity,
  tradePrice,
  setTradePrice,
  tradePreview,
  persistenceMode,
  onSubmit,
  onClose,
  onOpenRemoveAccount,
}: TradeModalProps) {
  const dialogRef = useModalFocus<HTMLFormElement>(isOpen, onClose);
  if (!isOpen) return null;

  const currentAccount = accountMap.get(selectedAccountId);
  const canRemoveAccount =
    selectedAccountId !== "__custom__" &&
    Boolean(currentAccount) &&
    !currentAccount?.archivedAt &&
    currentAccount?.broker !== "現金口座";

  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form ref={dialogRef} className="trade-modal" role="dialog" aria-modal="true" aria-labelledby="trade-modal-title" tabIndex={-1} onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            <span>{editingTransaction ? "EDIT TRADE" : "NEW TRADE"}</span>
            <h2 id="trade-modal-title">{editingTransaction ? "取引を編集" : "取引を記録"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="閉じる"
          >
            <X size={18} />
          </button>
        </div>

        <div className="segmented big">
          <button
            type="button"
            className={tradeType === "BUY" ? "active" : ""}
            onClick={() => setTradeType("BUY")}
          >
            買付
          </button>
          <button
            type="button"
            className={tradeType === "SELL" ? "active" : ""}
            onClick={() => setTradeType("SELL")}
          >
            売却
          </button>
        </div>

        <SecuritySearchField
          securities={nativeMarketSecurities}
          selected={selectedTradeSecurity}
          onSelect={selectTradeSecurity}
          onQueryActiveChange={setTradeSearchActive}
          onNetworkRequest={handleSearchNetworkRequest}
        />

        <div className="brokerage-select-row">
          <label className="brokerage-field">
            証券口座
            <select
              aria-label="証券口座"
              value={selectedAccountId}
              onChange={(event) => setSelectedAccountId(event.target.value)}
              required
            >
              {selectableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.archivedAt ? "（削除済み）" : ""}
                </option>
              ))}
              <option value="__custom__">その他の証券会社を追加…</option>
            </select>
          </label>
          <button
            type="button"
            className="remove-account-button"
            aria-label="選択中の証券口座を一覧から削除"
            title="この口座を一覧から削除"
            disabled={!canRemoveAccount}
            onClick={() => onOpenRemoveAccount(selectedAccountId)}
          >
            <Trash2 size={16} />
          </button>
        </div>

        {selectedAccountId === "__custom__" && (
          <label className="custom-broker-field">
            証券会社名
            <input
              value={customBroker}
              onChange={(event) => setCustomBroker(event.target.value)}
              placeholder="例: 楽天証券"
              autoFocus
              required
            />
          </label>
        )}

        <div className="form-grid trade-fields">
          <label>
            取引日
            <input
              type="date"
              value={tradeDate}
              max={localDateInputValue()}
              onChange={(event) => setTradeDate(event.target.value)}
              required
            />
          </label>
          <label>
            {isFundSecurity(selectedTradeSecurity) ? "口数" : "数量"}
            <input
              inputMode="decimal"
              enterKeyHint="next"
              autoComplete="off"
              value={tradeQuantity}
              onChange={(event) => setTradeQuantity(event.target.value)}
              placeholder={
                isFundSecurity(selectedTradeSecurity)
                  ? securityPriceUnit(selectedTradeSecurity) === 10_000
                    ? "10000"
                    : "1"
                  : isIndexSecurity(selectedTradeSecurity)
                    ? "1"
                    : "100"
              }
              required
            />
          </label>
          <label>
            {isFundSecurity(selectedTradeSecurity)
              ? `基準価額（${securityPriceBasis(selectedTradeSecurity)}・${selectedTradeSecurity?.currency ?? "JPY"}）`
              : isIndexSecurity(selectedTradeSecurity)
                ? `指数値（${selectedTradeSecurity?.currency ?? "USD"}）`
                : `価格（${selectedTradeSecurity?.currency ?? "JPY"}）`}
            <input
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              value={tradePrice}
              onChange={(event) => setTradePrice(event.target.value)}
              placeholder={
                isFundSecurity(selectedTradeSecurity)
                  ? securityPriceUnit(selectedTradeSecurity) === 10_000
                    ? "16,000"
                    : "900.00"
                  : isIndexSecurity(selectedTradeSecurity)
                    ? "5,000"
                    : "3,658"
              }
              required
            />
          </label>
        </div>

        <div className="trade-preview">
          <span>概算金額</span>
          <strong>
            {tradePreview != null && Number.isFinite(tradePreview)
              ? money(tradePreview, selectedTradeSecurity?.currency)
              : "—"}
          </strong>
        </div>

        <button
          className="trade-button full"
          type="submit"
          disabled={
            tradeSearchActive ||
            !selectedTradeSecurity ||
            tradePreview == null ||
            !Number.isFinite(tradePreview) ||
            (selectedAccountId === "__custom__" && !customBroker.trim())
          }
        >
          {tradeSearchActive
            ? "候補から銘柄を選択"
            : editingTransaction
              ? persistenceMode === "cloud"
                ? "変更を保存して同期"
                : "変更を端末に保存"
              : persistenceMode === "cloud"
                ? "保存して同期"
                : "端末に保存"}
        </button>

        <p className="privacy-note">
          <ShieldCheck size={14} />{" "}
          {persistenceMode === "cloud"
            ? `取引${editingTransaction ? "の変更" : "と証券口座"}は暗号化され、同じアカウントの端末へ同期されます。`
            : "同期設定前はこの端末内だけに保存されます。"}
        </p>
      </form>
    </div>
  );
}
