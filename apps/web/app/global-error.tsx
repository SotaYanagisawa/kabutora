"use client";

import { repairClientShell } from "@/lib/client-recovery";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return <html lang="ja"><body><main className="secure-gate client-recovery-gate"><h1>株トラを再読込します</h1><p>暗号化ポートフォリオを削除せず、アプリ画面だけを最新版へ切り替えます。</p><code>{error.name || "GLOBAL_ERROR"}{error.digest ? ` · ${error.digest}` : ""}</code><button className="trade-button secure-action" onClick={repairClientShell}>安全に修復して再読込</button><a className="text-button" href="/?force=v70">最新版を直接開く</a></main></body></html>;
}
