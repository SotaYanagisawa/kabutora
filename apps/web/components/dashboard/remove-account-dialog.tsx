"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { useModalFocus } from "./use-modal-focus";
import type { Seed } from "./types";

export type RemoveAccountDialogProps = {
  accountId: string | null;
  accountMap: Map<string, Seed["accounts"][number]>;
  transactions: Seed["transactions"];
  onConfirm: () => void;
  onCancel: () => void;
};

export function RemoveAccountDialog({
  accountId,
  accountMap,
  transactions,
  onConfirm,
  onCancel,
}: RemoveAccountDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(Boolean(accountId && accountMap.get(accountId)), onCancel);
  if (!accountId) return null;
  const account = accountMap.get(accountId);
  if (!account) return null;

  const hasTransactions = transactions.some((t) => t.accountId === accountId);
  const relatedCount = transactions.filter((t) => t.accountId === accountId).length;

  return (
    <div
      className="modal-layer delete-confirm-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <section
        className="delete-confirm account-remove-confirm"
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-account-title"
        aria-describedby="remove-account-warning"
      >
        <div className="delete-confirm-heading">
          <span className="delete-confirm-icon">
            <AlertTriangle size={21} />
          </span>
          <div>
            <small>取引口座一覧から削除</small>
            <h2 id="remove-account-title">この証券口座を削除しますか？</h2>
          </div>
        </div>
        <p id="remove-account-warning">
          {hasTransactions
            ? "この口座を使った過去の取引があります。今後の取引候補からは削除しますが、FIFO損益と履歴を正しく保つため、過去取引の口座情報は保持されます。"
            : "この口座は取引候補から削除され、同じGoogleアカウントのMacとiPhoneにも同期されます。"}
        </p>
        <dl className="delete-transaction-facts">
          <div>
            <dt>証券口座</dt>
            <dd>{account.name}</dd>
          </div>
          <div>
            <dt>証券会社</dt>
            <dd>{account.broker}</dd>
          </div>
          <div>
            <dt>口座種別</dt>
            <dd>
              {account.accountType === "nisa"
                ? "NISA"
                : account.accountType === "taxable"
                  ? "課税口座"
                  : account.accountType}
            </dd>
          </div>
          <div>
            <dt>関連取引</dt>
            <dd>{relatedCount}件</dd>
          </div>
        </dl>
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
            一覧から削除
          </button>
        </div>
      </section>
    </div>
  );
}
