"use client";

import Dashboard from "@/components/dashboard/dashboard";
import type { Seed } from "@/components/dashboard/types";
import EncryptedBackupDialog from "@/components/app/encrypted-backup-dialog";
import AppLoadingScreen from "@/components/app/app-loading-screen";
import { configureDeviceTrust, firebaseConfigured, type DeviceTrustMode } from "@/lib/sync/firebase-config";
import { Laptop, ShieldCheck, Users } from "lucide-react";
import type { MarketSessionStatus } from "@/lib/market/market-session";
import CloudPortfolioApp from "@/components/app/cloud-portfolio-app";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPTIONAL_STORAGE_TIMEOUT_MS, timeoutSignal, withDeadline } from "@/lib/ui/operation-deadline";
import { validatePortfolio } from "@/lib/portfolio/portfolio-validation";

function storedDeviceMode(): DeviceTrustMode | null {
  if (typeof window === "undefined") return null;
  try {
    const sessionMode = sessionStorage.getItem("kabutora-device-trust-session");
    if (sessionMode === "trusted" || sessionMode === "shared") return sessionMode;
    return localStorage.getItem("kabutora-device-trust") === "trusted" ? "trusted" : null;
  } catch {
    return null;
  }
}

export default function AppBootstrap({ initialServerTimeMs, initialMarketSessions }: { initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  const [localSeed, setLocalSeed] = useState<Seed | null>(null);
  const [backupSeed, setBackupSeed] = useState<Seed | null>(null);
  const [checkedLocal, setCheckedLocal] = useState(() => typeof window !== "undefined" && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));
  const [deviceMode, setDeviceMode] = useState<DeviceTrustMode | null>(() => {
    const storedMode = storedDeviceMode();
    if (storedMode) configureDeviceTrust(storedMode);
    return storedMode;
  });
  const [localSaveError, setLocalSaveError] = useState("");
  const [localLoadError, setLocalLoadError] = useState(false);
  const [localAttempt, setLocalAttempt] = useState(0);
  const localSeedRef = useRef<Seed | null>(null);
  const localSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) { setCheckedLocal(true); return; }
    let active = true;
    setLocalLoadError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPTIONAL_STORAGE_TIMEOUT_MS);
    fetch("/api/local/bootstrap", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.ok && response.status !== 204) {
          const loaded = validatePortfolio(await response.json());
          if (!active) return;
          localSeedRef.current = loaded;
          setLocalSeed(loaded);
        } else if (response.status !== 404 && response.status !== 204) throw new Error("local_vault_unavailable");
      })
      .catch(() => { if (active) setLocalLoadError(true); })
      .finally(() => { clearTimeout(timer); if (active) setCheckedLocal(true); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [localAttempt]);

  useEffect(() => {
    if (!firebaseConfigured || !deviceMode) return;
    void Promise.all([
      import("@/components/app/cloud-portfolio-app"),
      import("@/lib/sync/firebase-client").then(({ getFirebaseServices }) => withDeadline(getFirebaseServices().auth.authStateReady(), 15_000, "auth-preload")),
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
        if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) throw new Error("local_origin_required");
        const response = await fetch("/api/local/bootstrap", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(localSeedRef.current),
          signal: timeoutSignal(8_000),
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
    try {
      sessionStorage.setItem("kabutora-device-trust-session", mode);
      if (mode === "trusted") localStorage.setItem("kabutora-device-trust", mode);
    } catch { /* Shared/private WebKit contexts may disable storage. */ }
    setDeviceMode(mode);
  };

  useEffect(() => {
    if (!checkedLocal || localSeed || !firebaseConfigured || deviceMode) return;
    const storedMode = storedDeviceMode();
    if (storedMode) selectDeviceMode(storedMode);
  }, [checkedLocal, deviceMode, localSeed]);

  if (!checkedLocal) return <AppLoadingScreen label="保存データを確認中" detail="この端末の暗号化ポートフォリオを探しています" />;
  if (localLoadError) return <main className="secure-gate"><h1>端末の保存データを確認できませんでした</h1><p role="alert">データは削除されていません。接続を確認して再試行してください。</p><button className="trade-button" onClick={() => { setCheckedLocal(false); setLocalAttempt((value) => value + 1); }}>再試行</button><button className="text-button" onClick={() => setLocalLoadError(false)}>クラウド保管庫へ接続</button></main>;
  if (localSeed) return <>
    <Dashboard
      seed={localSeed}
      initialServerTimeMs={initialServerTimeMs}
      initialMarketSessions={initialMarketSessions}
      allowPersistentMarketCache={true}
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
