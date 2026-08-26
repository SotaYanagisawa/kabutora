"use client";

import { repairClientShell } from "@/lib/client-recovery";
import type { MarketSessionStatus } from "@/lib/market-session";
import AppLoadingScreen from "@/components/app-loading-screen";
import dynamic from "next/dynamic";
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";

const AppBootstrap = dynamic(() => import("@/components/app-bootstrap"), {
  ssr: false,
  loading: () => <AppLoadingScreen label="アプリ画面を準備中" detail="最新の画面構成を読み込んでいます" />,
});

class ClientErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; code: string }> {
  state = { failed: false, code: "CLIENT_RENDER" };

  static getDerivedStateFromError(error: Error) {
    return { failed: true, code: `${error.name || "Error"}: ${String(error.message || "render_failed").slice(0, 120)}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Kabutora client render failed", error.name, info.componentStack?.slice(0, 500));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="secure-gate client-recovery-gate"><h1>画面の更新が必要です</h1><p>暗号化データを残したまま、画面だけを最新版へ切り替えます。</p><code>{this.state.code}</code><button className="trade-button secure-action" onClick={repairClientShell}>修復して再読込</button><a className="text-button" href="/?force=v70">最新版を直接開く</a></main>;
  }
}

export default function ClientAppRoot({ initialServerTimeMs, initialMarketSessions }: { initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js?v=70", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => undefined);
  }, []);
  return <ClientErrorBoundary><AppBootstrap initialServerTimeMs={initialServerTimeMs} initialMarketSessions={initialMarketSessions} /></ClientErrorBoundary>;
}
