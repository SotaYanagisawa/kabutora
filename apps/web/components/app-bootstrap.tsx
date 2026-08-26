"use client";

import Dashboard, { type Seed } from "@/components/dashboard";
import EncryptedBackupDialog from "@/components/encrypted-backup-dialog";
import AppLoadingScreen from "@/components/app-loading-screen";
import { configureDeviceTrust, firebaseConfigured, type DeviceTrustMode } from "@/lib/firebase-config";
import { Laptop, ShieldCheck, Users } from "lucide-react";
import dynamic from "next/dynamic";
import type { MarketSessionStatus } from "@/lib/market-session";
import { useCallback, useEffect, useRef, useState } from "react";

const CloudPortfolioApp = dynamic(() => import("@/components/cloud-portfolio-app"), {
  ssr: false,
  loading: () => <AppLoadingScreen label="クラウド接続を準備中" detail="暗号化された同期機能を読み込んでいます" />,
});

function storedDeviceMode(): DeviceTrustMode | null {
  if (typeof window === "undefined") return null;
  const sessionMode = sessionStorage.getItem("kabutora-device-trust-session");
  if (sessionMode === "trusted" || sessionMode === "shared") return sessionMode;
  return localStorage.getItem("kabutora-device-trust") === "trusted" ? "trusted" : null;
}

export default function AppBootstrap({ initialServerTimeMs, initialMarketSessions }: { initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  const [localSeed, setLocalSeed] = useState<Seed | null>(null);
  const [backupSeed, setBackupSeed] = useState<Seed | null>(null);
  const [checkedLocal, setCheckedLocal] = useState(false);
  const [deviceMode, setDeviceMode] = useState<DeviceTrustMode | null>(() => {
    const storedMode = storedDeviceMode();
    if (storedMode) configureDeviceTrust(storedMode);
    return storedMode;
  });
  const [localSaveError, setLocalSaveError] = useState("");
  const localSeedRef = useRef<Seed | null>(null);
  const localSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    fetch("/api/local/bootstrap", { cache: "no-store" })
      .then(async (response) => {
        if (response.ok) {
          const loaded = await response.json() as Seed;
          localSeedRef.current = loaded;
          setLocalSeed(loaded);
        }
      })
      .finally(() => setCheckedLocal(true));
  }, []);

  useEffect(() => {
    if (!firebaseConfigured || !deviceMode) return;
    void Promise.all([
      import("@/components/cloud-portfolio-app"),
      import("@/lib/firebase-client").then(({ getFirebaseServices }) => getFirebaseServices().auth.authStateReady()),
    ]).catch(() => undefined);
  }, [deviceMode]);

  const persistLocalPatch = useCallback((patch: Partial<Pick<Seed, "accounts" | "securities" | "transactions">>) => {
    if (!localSeedRef.current) return;
    const next = { ...localSeedRef.current, ...patch };
    localSeedRef.current = next;
    setLocalSeed(next);
    const saveLatest = async () => {
      if (!localSeedRef.current) return;
      try {
        const response = await fetch("/api/local/bootstrap", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(localSeedRef.current),
        });
        if (!response.ok) throw new Error("save_failed");
        setLocalSaveError("");
      } catch {
        setLocalSaveError("暗号化ローカル保管庫へ保存できませんでした。再起動前にもう一度操作してください。");
      }
    };
    localSaveQueueRef.current = localSaveQueueRef.current.then(saveLatest, saveLatest);
    return localSaveQueueRef.current;
  }, []);

  const selectDeviceMode = (mode: DeviceTrustMode) => {
    configureDeviceTrust(mode);
    sessionStorage.setItem("kabutora-device-trust-session", mode);
    if (mode === "trusted") localStorage.setItem("kabutora-device-trust", mode);
    setDeviceMode(mode);
  };

  useEffect(() => {
    if (!checkedLocal || localSeed || !firebaseConfigured || deviceMode) return;
    const storedMode = storedDeviceMode();
    if (storedMode) selectDeviceMode(storedMode);
  }, [checkedLocal, deviceMode, localSeed]);

  if (!checkedLocal) return <AppLoadingScreen label="保存データを確認中" detail="この端末の暗号化ポートフォリオを探しています" />;
  if (localSeed) return <>
    <Dashboard
      seed={localSeed}
      initialServerTimeMs={initialServerTimeMs}
      initialMarketSessions={initialMarketSessions}
      onTransactionsChange={(transactions) => persistLocalPatch({ transactions })}
      onAccountsChange={(accounts) => persistLocalPatch({ accounts })}
      onSecuritiesChange={(securities) => persistLocalPatch({ securities })}
      onEncryptedBackup={setBackupSeed}
    />
    {localSaveError && <div className="cloud-error" role="alert">{localSaveError}</div>}
    {backupSeed && <EncryptedBackupDialog seed={backupSeed} onClose={() => setBackupSeed(null)} />}
  </>;
  if (firebaseConfigured && !deviceMode) return <main className="secure-gate device-gate">
    <ShieldCheck size={30}/><h1>この端末での保存方法</h1>
    <p>ポートフォリオは常に暗号文で同期されます。信頼できる個人端末だけ、オフライン用の暗号文キャッシュを保存してください。</p>
    <div className="device-options">
      <button className="device-option recommended" onClick={() => selectDeviceMode("trusted")}><Laptop size={22}/><span><strong>個人端末</strong><small>暗号文を端末に保持・オフライン対応</small></span></button>
      <button className="device-option" onClick={() => selectDeviceMode("shared")}><Users size={22}/><span><strong>共有端末</strong><small>メモリのみ・タブ終了時に破棄</small></span></button>
    </div>
  </main>;
  if (firebaseConfigured) return <CloudPortfolioApp deviceMode={deviceMode!} initialServerTimeMs={initialServerTimeMs} initialMarketSessions={initialMarketSessions} />;
  return <div className="secure-gate"><ShieldCheck size={30}/><h1>クラウド設定が必要です</h1><p>このビルドには個人データは含まれていません。Firebase環境変数を設定すると、認証済みクラウドモードで起動します。</p></div>;
}
