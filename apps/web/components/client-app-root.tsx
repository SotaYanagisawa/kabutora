"use client";

import { CLIENT_BUILD_ID, clientErrorCode, isReleaseMismatchError, reloadClient, removeLegacyShellWorker, repairClientShell } from "@/lib/client-recovery";
import type { MarketSessionStatus } from "@/lib/market-session";
import dynamic from "next/dynamic";
import AppLoadingScreen from "@/components/app-loading-screen";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { timeoutSignal } from "@/lib/operation-deadline";

const AppBootstrap = dynamic(() => import("@/components/app-bootstrap"), {
  ssr: false,
  loading: () => <AppLoadingScreen label="保存データを確認中" detail="この端末の暗号化ポートフォリオを探しています" />,
});

class ClientErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; code: string; releaseMismatch: boolean; error: Error | null }> {
  state = { failed: false, code: "CLIENT_RENDER", releaseMismatch: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return {
      failed: true,
      code: clientErrorCode(error),
      releaseMismatch: isReleaseMismatchError(error),
      error,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Kabutora client render failed", error.name, info.componentStack?.slice(0, 500));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.releaseMismatch) {
      return (
        <main className="secure-gate client-recovery-gate">
          <h1>新しい画面を読み込みます</h1>
          <p>暗号化データを残したまま、アプリ画面だけを更新します。</p>
          <code>{this.state.code} · {CLIENT_BUILD_ID}</code>
          <button className="trade-button secure-action" onClick={repairClientShell}>更新して再読込</button>
        </main>
      );
    }
    return (
      <main className="secure-gate client-recovery-gate">
        <h1>画面で問題が発生しました</h1>
        <p>価格データや通信の問題はポートフォリオの暗号化データを削除しません。</p>
        <code>{this.state.code} · {CLIENT_BUILD_ID}</code>
        {this.state.error?.message && (
          <p style={{ fontSize: "11px", color: "var(--muted)", wordBreak: "break-all", fontFamily: "monospace", margin: "8px 0" }}>
            {this.state.error.name}: {this.state.error.message}
          </p>
        )}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
          <button className="trade-button secure-action" onClick={repairClientShell}>キャッシュを消去して再読込</button>
          <button className="text-button" onClick={reloadClient}>通常再読込</button>
        </div>
      </main>
    );
  }
}

export default function ClientAppRoot({ initialServerTimeMs, initialMarketSessions }: { initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  const [newBuildAvailable, setNewBuildAvailable] = useState(false);
  useEffect(() => {
    if (!("virtualKeyboard" in navigator)) return;
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewport && !viewport.content.includes("interactive-widget")) viewport.content += ", interactive-widget=resizes-content";
  }, []);

  useEffect(() => {
    const repairTimer = window.setTimeout(() => {
      try { sessionStorage.removeItem("kabutora-chunk-repair"); } catch { /* Storage is optional. */ }
    }, 15_000);
    void removeLegacyShellWorker();
    const checkBuild = async () => {
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: timeoutSignal(3_000) });
        const payload = await response.json() as { buildId?: string };
        if (response.ok && payload.buildId && payload.buildId !== CLIENT_BUILD_ID) setNewBuildAvailable(true);
      } catch { /* A version check must never block the application. */ }
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void checkBuild(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void checkBuild(); };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(repairTimer);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return <ClientErrorBoundary>{newBuildAvailable && <div className="cloud-error" role="status">新しいバージョンがあります。<button className="text-button" onClick={repairClientShell}>画面を更新</button></div>}<AppBootstrap initialServerTimeMs={initialServerTimeMs} initialMarketSessions={initialMarketSessions} /></ClientErrorBoundary>;
}
