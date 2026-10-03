"use client";

import { CLIENT_BUILD_ID, isReleaseMismatchError, reloadClient, repairClientShell } from "@/lib/ui/client-recovery";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const mismatch = isReleaseMismatchError(error);
  return <html lang="ja"><body><main className="secure-gate client-recovery-gate"><h1>{mismatch ? "新しい画面を読み込みます" : "画面で問題が発生しました"}</h1><p>暗号化ポートフォリオは削除されません。</p><code>{error.name || "GLOBAL_ERROR"}{error.digest ? ` · ${error.digest}` : ""} · {CLIENT_BUILD_ID}</code><button className="trade-button secure-action" onClick={mismatch ? repairClientShell : reloadClient}>{mismatch ? "更新して再読込" : "もう一度読み込む"}</button></main></body></html>;
}
