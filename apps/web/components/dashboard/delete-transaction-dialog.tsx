"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import {
  dateJa,
  maybeMoney,
  number,
  securityQuantityUnit,
} from "./helpers";
import { useModalFocus } from "./use-modal-focus";
import type { SearchSecurity, Seed } from "./types";

export type DeleteTransactionDialogProps = {
  transaction: Seed["transactions"][number] | null;
  rawSecurityMap: Map<string, SearchSecurity>;
  accountMap: Map<string, Seed["accounts"][number]>;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DeleteTransactionDialog({
  transaction,
  rawSecurityMap,
  accountMap,
  onConfirm,
  onCancel,
}: DeleteTransactionDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(Boolean(transaction), onCancel);
  if (!transaction) return null;

  const security = transaction.securityId
    ? rawSecurityMap.get(transaction.securityId)
    : undefined;
  const account = accountMap.get(transaction.accountId);

  return (
    <div
      className="modal-layer delete-confirm-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <section
        className="delete-confirm"
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-transaction-title"
        aria-describedby="delete-transaction-warning"
      >
        <div className="delete-confirm-heading">
          <span className="delete-confirm-icon">
            <AlertTriangle size={21} />
          </span>
          <div>
            <small>取引履歴から削除</small>
            <h2 id="delete-transaction-title">この取引を削除しますか？</h2>
          </div>
        </div>
        <p id="delete-transaction-warning">
          削除すると、保有数・平均取得単価・実現損益・パフォーマンス履歴が再計算され、同じアカウントのMacとiPhoneにも反映されます。
        </p>
        <dl className="delete-transaction-facts">
          <div>
            <dt>取引</dt>
            <dd>
              {transaction.type === "BUY"
                ? "買付"
                : transaction.type === "SELL"
                  ? "売却"
                  : transaction.type}
            </dd>
          </div>
          <div>
            <dt>取引日</dt>
            <dd>{dateJa(transaction.tradeDate)}</dd>
          </div>
          <div>
            <dt>銘柄</dt>
            <dd>
              {transaction.securityId
                ? `${security?.name ?? "不明な銘柄"} · ${security?.displaySymbol ?? "—"}`
                : "現金"}
            </dd>
          </div>
          <div>
            <dt>証券口座</dt>
            <dd>{account?.name ?? "口座未設定"}</dd>
          </div>
          <div>
            <dt>数量</dt>
            <dd>
              {transaction.quantity
                ? `${number.format(Math.abs(Number(transaction.quantity)))}${securityQuantityUnit(rawSecurityMap.get(transaction.securityId ?? ""))}`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>約定単価</dt>
            <dd>
              {transaction.pricePerShare != null
                ? maybeMoney(transaction.pricePerShare, transaction.tradeCurrency ?? "JPY")
                : "—"}
            </dd>
          </div>
          <div className="delete-transaction-total">
            <dt>約定金額</dt>
            <dd>
              {maybeMoney(transaction.grossAmount, transaction.tradeCurrency ?? "JPY")}
            </dd>
          </div>
        </dl>
        <strong className="delete-warning">この操作は元に戻せません。</strong>
        <div className="delete-confirm-actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={onConfirm}
          >
            <Trash2 size={15} />
            削除する
          </button>
        </div>
      </section>
    </div>
  );
}
