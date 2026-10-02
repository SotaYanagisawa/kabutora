"use client";

import Dashboard, { type Seed } from "@/components/dashboard";
import AppLoadingScreen from "@/components/app-loading-screen";
import EncryptedBackupDialog from "@/components/encrypted-backup-dialog";
import { completeKabutoraSignInRedirect, enableMemoryFirebaseFallback, getFirebaseServices, signInToKabutora, signOutOfKabutora } from "@/lib/firebase-client";
import { createFirebasePortfolioCloudStore } from "@/lib/portfolio-cloud-store";
import { PortfolioSession, type RecoverySetup, type SessionState } from "@/lib/portfolio-session";
import { isKabutoraVaultEnvelope, type KabutoraVaultEnvelope } from "@/lib/vault-crypto";
import { deleteTrustedDeviceKey } from "@/lib/trusted-device-key-store";
import { portfolioQueueState, subscribePortfolioQueue } from "@/lib/portfolio-offline-queue";
import { settleInitialAuthSession } from "@/lib/initial-auth-session";
import { startupLabels, type PortfolioStartupState, type StartupStage } from "@/lib/portfolio-startup";
import { diffTransactionChanges } from "@/lib/transaction-event-merge";
import { isNewerAccountRevision } from "@/lib/account-event-merge";
import { clearInMemorySnapshotCache, getCachedServerMarketSnapshot, loadStartupMarketSnapshots } from "@/lib/client-market-service";
import { clearCompactQuotesCache } from "@/lib/client-market-cache";
import type { ServerMarketSnapshot } from "@/lib/server-market-types";
import type { MarketSessionStatus } from "@/lib/market-session";
import type { DeviceTrustMode } from "@/lib/firebase-config";
import { pendingSyncIndicatorDelay } from "@/lib/sync-status";
import { PreferenceSaveScheduler } from "@/lib/preference-save-scheduler";
import type { SearchSecurity, UserPreferences } from "@/components/dashboard/types";
import type { User } from "firebase/auth";
import { FileKey, KeyRound, LockKeyhole, LogOut, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const initialState: SessionState = { startup: { stage: "vault" }, seed: null, envelope: null, needsUnlock: false, cached: false, cachedAvailable: false, warning: "" };
const message = (error: unknown) => error instanceof Error ? error.message : "処理を完了できませんでした。再試行してください。";

export default function CloudPortfolioApp({ deviceMode, initialServerTimeMs, initialMarketSessions }: { deviceMode: DeviceTrustMode; initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeUid, setActiveUid] = useState<string | null>(() => {
    if (typeof window === "undefined" || deviceMode !== "trusted") return null;
    try { return localStorage.getItem("kabutora-active-uid"); } catch { return null; }
  });
  const targetUid = user?.uid ?? (deviceMode === "trusted" ? activeUid : null);
  const [authState, setAuthState] = useState<PortfolioStartupState>({ stage: "authentication" });
  const [attempt, setAttempt] = useState(0);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [state, setState] = useState<SessionState>(initialState);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unlockValue, setUnlockValue] = useState("");
  const [unlockMode, setUnlockMode] = useState<"passphrase" | "recovery">("passphrase");
  const [importEnvelope, setImportEnvelope] = useState<KabutoraVaultEnvelope | null>(null);
  const [setup, setSetup] = useState<RecoverySetup | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [backupSeed, setBackupSeed] = useState<Seed | null>(null);
  const [queue, setQueue] = useState({ pending: 0, memoryOnly: 0, storageUnavailable: false });
  const [debouncedPending, setDebouncedPending] = useState(false);
  const [market, setMarket] = useState<ServerMarketSnapshot | null | undefined>(() => getCachedServerMarketSnapshot("compact"));
  const session = useRef<PortfolioSession | null>(null);
  const preferenceSaveScheduler = useRef<PreferenceSaveScheduler<UserPreferences> | null>(null);

  useEffect(() => {
    if (queue.pending <= 0) {
      setDebouncedPending(false);
      return;
    }
    const delay = pendingSyncIndicatorDelay(typeof navigator === "undefined" || navigator.onLine);
    const timer = window.setTimeout(() => {
      setDebouncedPending(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [queue.pending]);

  useEffect(() => {
    const { auth } = getFirebaseServices();
    let active = true;
    let initialized = false;
    setAuthState({ stage: "authentication" });
    const apply = (next: User | null) => {
      if (!active) return;
      setUser(next);
      setLocked(false);
      setSetup(null); setPassphrase(""); setConfirmation(""); setUnlockValue(""); setImportEnvelope(null); setBackupSeed(null);
      if (next) {
        if (deviceMode === "trusted") {
          try { localStorage.setItem("kabutora-active-uid", next.uid); } catch {}
          setActiveUid(next.uid);
        }
        setAuthState({ stage: "vault" });
        session.current?.connectCloud();
      } else {
        if (deviceMode === "trusted") {
          try { localStorage.removeItem("kabutora-active-uid"); } catch {}
          setActiveUid(null);
        }
        setAuthState({ stage: "signed-out" });
      }
    };
    const unsubscribe = auth.onAuthStateChanged((next) => { if (initialized) apply(next); });
    void settleInitialAuthSession({ completeRedirect: completeKabutoraSignInRedirect, authStateReady: () => auth.authStateReady(), currentUser: () => auth.currentUser }).then((result) => {
      if (!active) return;
      initialized = true;
      apply(result.user);
      if (result.redirectFailed) setError("Googleサインインの結果を確認できませんでした。再試行してください。");
    }).catch((cause) => { if (active) setAuthState({ stage: "recoverable-error", failedStage: "authentication", message: message(cause) }); });
    return () => { active = false; unsubscribe(); };
  }, [attempt, deviceMode]);

  useEffect(() => {
    if (!targetUid || locked) { session.current?.stop(); session.current = null; setState(initialState); return; }
    setState(initialState);
    const next = new PortfolioSession(
      targetUid,
      deviceMode,
      createFirebasePortfolioCloudStore(getFirebaseServices().db),
      setState,
      () => {
        const current = getFirebaseServices().auth.currentUser;
        return !current || current.uid === targetUid;
      },
      () => {
        const current = getFirebaseServices().auth.currentUser;
        return Boolean(current && current.uid === targetUid);
      },
    );
    session.current = next;
    next.start();
    const updateQueue = () => setQueue(portfolioQueueState(targetUid));
    updateQueue();
    const unsubscribe = subscribePortfolioQueue(updateQueue);
    const flush = () => { void next.flush(); };
    const timer = setInterval(flush, 5_000);
    window.addEventListener("online", flush);
    return () => { unsubscribe(); clearInterval(timer); window.removeEventListener("online", flush); next.stop(); if (session.current === next) session.current = null; };
  }, [deviceMode, locked, sessionAttempt, targetUid]);

  useEffect(() => {
    if (!targetUid || locked || !session.current) {
      preferenceSaveScheduler.current?.cancel();
      preferenceSaveScheduler.current = null;
      return;
    }
    const scheduler = new PreferenceSaveScheduler<UserPreferences>(async (value) => {
      try {
        await session.current?.save([{ kind: "preferences", value }]);
      } catch (cause) {
        setError(message(cause));
      }
    }, 2_500);
    preferenceSaveScheduler.current = scheduler;
    const flush = () => { void scheduler.flush(); };
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      void scheduler.flush();
      if (preferenceSaveScheduler.current === scheduler) preferenceSaveScheduler.current = null;
    };
  }, [locked, sessionAttempt, targetUid]);

  const schedulePreferenceSave = useCallback((value: UserPreferences) => {
    preferenceSaveScheduler.current?.enqueue(value);
  }, []);

  useEffect(() => {
    clearInMemorySnapshotCache();
    if (!targetUid) { setMarket(null); return; }
    let active = true;
    void loadStartupMarketSnapshots({
      allowPersistentCache: deviceMode === "trusted",
      onSnapshot: (snapshot) => { if (active) setMarket(snapshot); },
    });
    return () => { active = false; };
  }, [deviceMode, targetUid, user]);

  const lock = useCallback(() => { session.current?.stop(); setLocked(true); setUnlockValue(""); setPassphrase(""); setConfirmation(""); setSetup(null); setBackupSeed(null); }, []);
  useEffect(() => {
    if (!state.seed || deviceMode !== "shared") return;
    let timer = window.setTimeout(lock, 10 * 60 * 1000);
    const activity = () => { clearTimeout(timer); timer = window.setTimeout(lock, 10 * 60 * 1000); };
    const hidden = () => { if (document.visibilityState === "hidden") lock(); };
    for (const name of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(name, activity, { passive: true });
    window.addEventListener("pagehide", lock);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(timer);
      for (const name of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(name, activity);
      window.removeEventListener("pagehide", lock); document.removeEventListener("visibilitychange", hidden);
    };
  }, [deviceMode, lock, Boolean(state.seed)]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const signOut = () => run(async () => {
    if (deviceMode === "trusted") {
      try {
        localStorage.removeItem("kabutora-active-uid");
        clearCompactQuotesCache();
      } catch {}
      setActiveUid(null);
    }
    lock();
    if (targetUid && deviceMode === "trusted") await deleteTrustedDeviceKey(targetUid).catch(() => undefined);
    await signOutOfKabutora();
  });
  const importFile = (file: File | undefined) => run(async () => {
    if (!file) return;
    if (file.size > 2_000_000) throw new Error("バックアップが大きすぎます。暗号化JSONを確認してください。");
    const value: unknown = JSON.parse(await file.text());
    if (!isKabutoraVaultEnvelope(value)) throw new Error("株トラの暗号化バックアップではありません。");
    setImportEnvelope(value); setUnlockValue("");
  });
  const unlockForm = <form className="unlock-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
    await session.current?.unlock(unlockValue, unlockMode, importEnvelope ?? undefined);
    setUnlockValue(""); setImportEnvelope(null);
  }); }}>
    <div className="segmented big"><button type="button" className={unlockMode === "passphrase" ? "active" : ""} onClick={() => setUnlockMode("passphrase")}>パスフレーズ</button><button type="button" className={unlockMode === "recovery" ? "active" : ""} onClick={() => setUnlockMode("recovery")}>復旧キー</button></div>
    <input aria-label={unlockMode === "passphrase" ? "解除パスフレーズ" : "解除復旧キー"} type="password" autoComplete="off" value={unlockValue} onChange={(event) => setUnlockValue(event.target.value)} placeholder={unlockMode === "passphrase" ? "16文字以上" : "KBT1-…"} required />
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="trade-button full" disabled={busy}>{busy ? "端末内で復号中…" : "復号して同期を開始"}</button>
    {importEnvelope && <button type="button" className="text-button" onClick={() => setImportEnvelope(null)}>キャンセル</button>}
  </form>;

  if (locked) return <SecureGate title="ポートフォリオはロック中" description={deviceMode === "trusted" ? "この端末に保存した解除鍵で再度開きます。" : "パスフレーズまたは復旧キーで再度開きます。"} icon={<LockKeyhole/>}>
    <button className="trade-button" onClick={() => setLocked(false)}>ポートフォリオを開く</button><button className="text-button" onClick={() => void signOut()}>ログアウト</button>
  </SecureGate>;
  if (importEnvelope || state.needsUnlock) return <SecureGate title={importEnvelope ? "バックアップを復元" : "この端末で保管庫を解除"} description={importEnvelope ? "バックアップのパスフレーズまたは復旧キーを入力してください。" : (deviceMode === "trusted" ? "iPhoneなど既に開いている端末がある場合は、その端末で株トラを開くだけでGoogleアカウント連携が自動修復され、この端末でも自動的に開きます。直接解除する場合はパスフレーズまたは復旧キーを入力してください。" : "共有端末では解除鍵やポートフォリオを保存しません。")} icon={<KeyRound/>}>
    {unlockForm}<button className="text-button" onClick={() => void signOut()}>別のアカウントを使用</button>
  </SecureGate>;
  if (state.startup.stage === "recoverable-error") return <SecureGate title={`${startupLabels[state.startup.failedStage]}：接続を回復できませんでした`} icon={<LockKeyhole/>}>
    <p role="alert">{state.startup.message}</p><button className="trade-button" onClick={() => { setError(""); setSessionAttempt((value) => value + 1); }}>再試行</button>
    {state.cachedAvailable && <button className="text-button" onClick={() => void run(() => session.current!.openCached())}>確認済みキャッシュを開く（最新の変更は未確認）</button>}
    {error && <p role="alert">{error}</p>}<button className="text-button" onClick={() => void signOut()}>ログアウト</button>
  </SecureGate>;
  if (state.startup.stage === "empty") return <SecureGate title="暗号化バックアップを読み込む" description="Macの株トラで作成した暗号化JSONを選択します。端末内で復号を確認し、復旧方法を設定して同期します。" icon={<FileKey/>}>
    <label className="file-button"><Upload size={16}/>ファイルを選択<input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])}/></label>
    {error && <p role="alert">{error}</p>}<button className="text-button" onClick={() => void signOut()}><LogOut size={14}/>別のアカウントを使用</button>
  </SecureGate>;
  if (state.startup.stage === "enrollment") return <SecureGate className="recovery-enrollment-gate" title="保管庫を安全に移行" description="過去の取引・口座・設定は削除せず、暗号化したまま新しい保管庫へ移します。" icon={<KeyRound/>}>
    {state.recoveryPending && <button className="trade-button full recovery-resume-button" disabled={busy} onClick={() => void run(() => session.current!.resumeRecovery())}>確認済みの移行を再開</button>}
    {session.current?.needsLegacyCredential() ? <section className="recovery-enrollment-panel" aria-labelledby="legacy-unlock-title">
      <div className="recovery-step" aria-label="移行ステップ 1/3">1 / 3</div>
      <h2 id="legacy-unlock-title">以前の保管庫を解除</h2>
      <p>未同期の変更も含めて保持するため、これまで使用していたパスフレーズまたは復旧キーを一度だけ入力します。</p>
      {unlockForm}
    </section> : setup ? <form className="unlock-form recovery-enrollment-panel" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await session.current!.activateRecovery(setup, confirmation); setSetup(null); setConfirmation(""); setPassphrase("");
    }); }}>
      <div className="recovery-step" aria-label="移行ステップ 2/2">2 / 2</div>
      <h2>復旧キーを保存して確認</h2>
      <p>下のキーをパスワード管理アプリなどへ保存してください。確認が終わるまで保管庫は切り替わりません。</p>
      <label className="recovery-key-label">新しい復旧キー<textarea className="recovery-key-output" aria-label="新しい復旧キー" readOnly value={setup.recoveryKey} rows={4} spellCheck={false}/></label>
      <label>保存した復旧キーを入力<input aria-label="復旧キーの確認" type="password" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="KBT1-…" required/></label>
      <button className="trade-button full" disabled={busy}>{busy ? "変更を照合して暗号化中…" : "保存したキーを確認して移行"}</button>
      <button className="text-button" type="button" disabled={busy} onClick={() => { setSetup(null); setConfirmation(""); }}>設定し直す</button>
    </form> : <form className="unlock-form recovery-enrollment-panel" onSubmit={(event) => { event.preventDefault(); void run(async () => { setSetup(await session.current!.prepareRecovery(passphrase)); setPassphrase(""); }); }}>
      <div className="recovery-step" aria-label="移行ステップ 1/2">1 / 2</div>
      <h2>新しいパスフレーズを作成</h2>
      <p>今後この保管庫を開くための、16文字以上の新しいパスフレーズです。以前の取引データはそのまま引き継がれます。</p>
      <label>新しいパスフレーズ<input aria-label="新しいパスフレーズ" type="password" autoComplete="new-password" minLength={16} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="16文字以上" required/></label>
      <button className="trade-button full" disabled={busy}>{busy ? "端末内で鍵を作成中…" : "次へ：復旧キーを作成"}</button>
    </form>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="text-button" disabled={busy} onClick={() => void signOut()}>ログアウト</button>
  </SecureGate>;

  const ready = Boolean(targetUid && state.seed && state.startup.stage === "ready");
  if (!ready) {
    if (authState.stage === "authentication") return <AppLoadingScreen label={startupLabels.authentication}/>;
    if (authState.stage === "recoverable-error") return <SecureGate title="サインインを確認できませんでした" icon={<LockKeyhole/>}>
      <p role="alert">{authState.message}</p><button className="trade-button" onClick={() => { enableMemoryFirebaseFallback(); setAttempt((value) => value + 1); }}>メモリモードで再試行</button>
    </SecureGate>;
    if (!user) return <SecureGate title="株トラへサインイン" icon={<LockKeyhole/>}>
      <button className="google-signin-button" aria-label="Googleでサインイン" disabled={busy} onClick={() => void run(signInToKabutora)}><img src="/sign-in-with-google.png" alt="" width="720" height="160"/></button>
      {error && <p role="alert">{error}</p>}
    </SecureGate>;
    return <AppLoadingScreen label={startupLabels[state.startup.stage as StartupStage] ?? "ポートフォリオを準備中"}/>;
  }

  const readySeed = state.seed!;
  const readyUid = targetUid!;

  const saveTransactions = async (transactions: Seed["transactions"]) => {
    const current = session.current?.state.seed; if (!current) return;
    const changes = diffTransactionChanges(current.transactions, transactions);
    await session.current!.save([...changes.upserts.map((value) => ({ kind: "transaction" as const, value })), ...changes.deletions.map((value) => ({ kind: "transaction-delete" as const, value: { id: value.id, deletedAt: new Date().toISOString() } }))]);
  };
  const saveAccounts = async (accounts: Seed["accounts"]) => {
    const known = new Map(session.current?.state.seed?.accounts.map((value) => [value.id, value]));
    await session.current!.save(accounts.filter((value) => !known.has(value.id) || isNewerAccountRevision(value, known.get(value.id)!)).map((value) => ({ kind: "account", value })));
  };
  const saveSecurities = async (securities: Seed["securities"]) => {
    const known = new Map(session.current?.state.seed?.securities.map((value) => [value.id, value]));
    await session.current!.save(securities.filter((value) => JSON.stringify(known.get(value.id)) !== JSON.stringify(value)).map((value) => ({ kind: "security", value })));
  };
  const saveWatchlist = (value: SearchSecurity[]) => session.current!.save([{ kind: "watchlist", value }]);
  const save = <T,>(action: (value: T) => Promise<void>) => async (value: T) => { try { await action(value); } catch (cause) { setError(message(cause)); } };

  const showSyncBanner = Boolean(
    state.warning ||
    queue.storageUnavailable ||
    (debouncedPending && queue.pending > 0)
  );

  return <div className="cloud-shell" data-startup-state="ready">
    {showSyncBanner && <details className="sync-status">
      <summary><span role="status">{state.warning || queue.storageUnavailable ? "同期の確認が必要です" : `クラウド同期待ち：${queue.pending}件`}</span></summary>
      <div className="sync-status-content">
        {queue.storageUnavailable && <span>端末の保存領域を確認できません。以前の未同期データは削除されていません。保存領域の回復後に再試行してください。 </span>}
        {state.warning && <span>{state.warning} </span>}
        {queue.pending > 0 && <span>{queue.memoryOnly > 0 ? `このタブに保持中：${queue.memoryOnly}件。閉じる前にクラウド同期を完了してください。` : `端末に保存済み：${queue.pending}件。クラウド同期を待っています。`}</span>}
      </div>
      <button className="text-button" onClick={() => void run(async () => { if (state.unsaved) await session.current?.retryFailedSaves(); await session.current?.flush(true); })}>同期を再試行</button>
    </details>}
    {queue.pending === 0 && !state.unsaved && !state.cached && <span className="sr-only" role="status">クラウド同期確認済み</span>}
    {error && <div className="cloud-error" role="alert">{error}<button className="text-button" onClick={() => setError("")}>閉じる</button></div>}
    <Dashboard key={readyUid} seed={readySeed} initialServerTimeMs={initialServerTimeMs} initialMarketSessions={initialMarketSessions} initialMarketSnapshot={market} persistenceMode="cloud" preferenceNamespace={readyUid} onTransactionsChange={save(saveTransactions)} onAccountsChange={save(saveAccounts)} onSecuritiesChange={save(saveSecurities)} onWatchlistChange={save(saveWatchlist)} onPreferencesChange={schedulePreferenceSave} onEncryptedBackup={setBackupSeed} onRestoreBackup={(file) => void importFile(file)} allowPlaintextExport={true} allowPersistentMarketCache={deviceMode === "trusted"} onLock={lock} onLogout={signOut} onStartupReady={() => performance.mark("kabutora:dashboard-interactive")}/>
    {backupSeed && <EncryptedBackupDialog seed={backupSeed} ownerUid={readyUid} onClose={() => setBackupSeed(null)}/>}
  </div>;
}
function SecureGate({ icon, title, description, children, className }: { icon: React.ReactNode; title: string; description?: string; children?: React.ReactNode; className?: string }) {
  return <main className={`secure-gate${className ? ` ${className}` : ""}`}><div className="secure-gate-icon">{icon}</div><h1>{title}</h1>{description && <p>{description}</p>}{children}</main>;
}
