"use client";

import type { Seed } from "@/components/dashboard";
import { createEncryptedVault, serializeVault, type KabutoraVaultEnvelope } from "@/lib/vault-crypto";
import { Download, KeyRound, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

const downloadText = (name: string, content: string, type = "text/plain;charset=utf-8") => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function EncryptedBackupDialog({ seed, ownerUid, onClose, onCreated }: {
  seed: Seed;
  ownerUid?: string;
  onClose: () => void;
  onCreated?: (envelope: KabutoraVaultEnvelope, dataKey: CryptoKey) => Promise<void> | void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [backupFile, setBackupFile] = useState<{ stamp: string; content: string } | null>(null);
  const recoveryText = (key: string) => `株トラ 復旧キー\n\n${key}\n\nこのキーは暗号化データを復号できます。クラウドストレージへ保存せず、パスワード管理アプリまたは紙で安全に保管してください。\n`;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passphrase !== confirmation) return setError("パスフレーズが一致しません。");
    setBusy(true);
    setError("");
    try {
      const created = await createEncryptedVault(seed, passphrase, ownerUid);
      await onCreated?.(created.envelope, created.dataKey);
      const stamp = new Date().toISOString().slice(0, 10);
      const content = serializeVault(created.envelope);
      setBackupFile({ stamp, content });
      downloadText(`kabutora-encrypted-${stamp}.json`, content, "application/json;charset=utf-8");
      downloadText(
        `kabutora-recovery-key-${stamp}.txt`,
        recoveryText(created.recoveryKey),
      );
      setRecoveryKey(created.recoveryKey);
      setPassphrase("");
      setConfirmation("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暗号化バックアップを作成できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-layer" role="presentation">
    <form className="trade-modal secure-modal" onSubmit={create}>
      <div className="modal-head"><div><span>END-TO-END ENCRYPTION</span><h2>暗号化バックアップ</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="閉じる"><X size={18}/></button></div>
      {recoveryKey ? <div className="recovery-result">
        <ShieldCheck size={24}/><strong>暗号化ファイルを作成しました</strong>
        <p>暗号化ファイルと復旧キーの両方が保存されたことを確認してください。ブラウザが連続ダウンロードを止めた場合は、以下から個別に保存できます。</p>
        <code>{recoveryKey}</code>
        {backupFile && <>
          <button type="button" className="secondary-button" onClick={() => downloadText(`kabutora-encrypted-${backupFile.stamp}.json`, backupFile.content, "application/json;charset=utf-8")}>暗号化ファイルを保存</button>
          <button type="button" className="secondary-button" onClick={() => downloadText(`kabutora-recovery-key-${backupFile.stamp}.txt`, recoveryText(recoveryKey))}>復旧キーを保存</button>
        </>}
        <button type="button" className="trade-button full" onClick={onClose}>完了</button>
      </div> : <>
        <p className="secure-copy"><KeyRound size={16}/> 16文字以上の専用パスフレーズで暗号化します。株トラ、Firebase、Cloudflareのいずれにも送信されません。</p>
        <label>暗号化パスフレーズ<input type="password" autoComplete="new-password" minLength={16} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required /></label>
        <label>パスフレーズを再入力<input type="password" autoComplete="new-password" minLength={16} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="trade-button full" disabled={busy} type="submit"><Download size={15}/>{busy ? "暗号化中…" : "暗号化してダウンロード"}</button>
      </>}
    </form>
  </div>;
}
