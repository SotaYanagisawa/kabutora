import { test, expect, type Page } from "../e2e/strict-fixture";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { createEncryptedVault, createGoogleProtectedVault, createRecoveryVault, decryptVaultWithDataKey } from "../lib/vault-crypto";
import demo from "../data/demo-seed.json";
import { readFile } from "node:fs/promises";

const projectId = "demo-kabutora-security-rules";
const password = "kabutora-emulator-only-password";
const passphrase = "synthetic browser recovery passphrase";
async function seedCloud(legacy = false) {
  if (!process.env.FIRESTORE_EMULATOR_HOST?.startsWith("127.0.0.1:")) throw new Error("Isolated Firebase emulators are required");
  const credentials = { email: "synthetic@kabutora.test", password, returnSecureToken: true };
  const auth = async (method: string) => fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:${method}?key=demo-emulator-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) }).then((response) => response.json());
  let account = await auth("signUp");
  if (!account.localId) account = await auth("signInWithPassword");
  if (!account.localId) throw new Error("Synthetic auth setup failed");
  const uid = account.localId as string;
  const environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } });
  await environment.clearFirestore();
  const created = legacy ? await createGoogleProtectedVault(demo, uid) : await createRecoveryVault(demo, passphrase, uid);
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "appAccess", uid), {});
    await setDoc(doc(db, "users", uid, "vaults", "default"), created.envelope);
    if (legacy && "accountKey" in created) await setDoc(doc(db, "users", uid, "keys", "google-account"), {
      format: "kabutora-google-account-key", version: 1, ownerUid: uid, keyId: "01234567-89ab-cdef-0123-456789abcdef", encodedKey: created.accountKey, createdAt: "", updatedAt: "",
    });
  });
  return { environment, uid, created };
}

async function marketRoutes(page: Page, snapshot?: Record<string, unknown>) {
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/market/quotes", (route) => route.fulfill({ json: { quotes: [], intraday: [], failures: [], coverage: { requested: 0, returned: 0 } } }));
  await page.route("**/api/market/history", (route) => route.fulfill({ json: { bars: [], corporateActions: [], failures: [], coverage: { requested: 0, returned: 0 } } }));
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({ json: { benchmarks: [], failures: [] } }));
  await page.route("**/api/market/intraday**", (route) => route.fulfill({ json: { bars: [], sessions: [], coverage: { requested: 0, ready: 0, currentReady: 0 }, revision: null, generatedAt: new Date().toISOString() } }));
  if (snapshot) await page.route("**/api/market/snapshot**", (route) => route.fulfill({ json: snapshot, headers: { ETag: `"cloud-sparkline-fixture"` } }));
}
async function signIn(page: Page, mode: "個人端末" | "共有端末", snapshot?: Record<string, unknown>) {
  await marketRoutes(page, snapshot);
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(mode) }).click();
  await page.getByRole("button", { name: "Googleでサインイン" }).click();
}
async function recover(page: Page, key: string) {
  await page.getByRole("button", { name: "復旧キー", exact: true }).click();
  await page.getByLabel("解除復旧キー", { exact: true }).fill(key);
  await page.getByRole("button", { name: "復号して同期を開始" }).click();
  await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 20_000 });
}

async function reloadCloud(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  await page.reload({ waitUntil: "domcontentloaded" });
  // WebKit reports cancellation of the departing document's open Firestore
  // stream as a CORS pageerror (firebase/firebase-js-sdk#3708). This assertion
  // permits only that exact emulator endpoint during document replacement.
  // Errors in the new document, other endpoints and all JS exceptions fail.
  expect(errors.length).toBeLessThanOrEqual(2);
  for (const error of errors) expect(error).toMatch(/^unhandled: .*127\.0\.0\.1:8085\/google\.firestore\.v1\.Firestore\/Listen\/channel\?.* due to access control checks\.$/u);
  errors.splice(0);
}

test("cloud authentication, first-device recovery and trusted-device automatic unlock", async ({ page, applicationErrors }) => {
  const { environment, created } = await seedCloud();
  try {
    await signIn(page, "個人端末");
    await expect(page.getByText("この端末で保管庫を解除", { exact: true })).toBeVisible();
    await recover(page, created.recoveryKey);
    await reloadCloud(page, applicationErrors);
    await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("解除復旧キー")).toHaveCount(0);
  } finally { await environment.cleanup(); }
});

test("cloud US sparkline shows the newest session immediately when its first observation arrives", async ({ page }) => {
  const { environment, created } = await seedCloud();
  const generatedAt = new Date().toISOString();
  const currentDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const previous = new Date(`${currentDate}T12:00:00Z`);
  do previous.setUTCDate(previous.getUTCDate() - 1); while (previous.getUTCDay() === 0 || previous.getUTCDay() === 6);
  const previousDate = previous.toISOString().slice(0, 10);
  const bars = [
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T13:30:00.000Z`, price: "220", provider: "fixture" },
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T16:00:00.000Z`, price: "224", provider: "fixture" },
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T20:00:00.000Z`, price: "222", provider: "fixture" },
    { securityId: "sec-us-aapl", timestamp: generatedAt, price: "223", provider: "fixture" },
  ];
  const quotes = [
    { securityId: "sec-us-aapl-xnas", symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price: "223", previousRegularClose: "222", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "near_live", provider: "fixture", session: "pre_market", priceType: "extended_hours", venueCode: "US", validationStatus: "valid" },
    { securityId: "sec-fx-usdjpy", symbol: "USDJPY=X", exchangeMic: "FX", currency: "JPY", price: "150", previousRegularClose: "150", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "near_live", provider: "fixture", session: "regular", priceType: "indicative", venueCode: "FX", validationStatus: "valid" },
  ];
  const snapshot = {
    schemaVersion: 1, generatedAt, savedAt: generatedAt, marketSessions: [], quotes,
    benchmarks: [{ id: "usd-jpy", label: "USD/JPY", symbol: "USDJPY=X", value: 150, changeRatio: 0, marketTimestamp: generatedAt, freshness: "near_live" }],
    intraday: bars, intradayRevision: generatedAt,
    coverage: { registered: 2, quoted: 2, fresh: 2, stale: 0, suspect: 0 },
    refresh: { status: "ready", lastRunAt: generatedAt, queueMessagesToday: 0, providerCallsToday: 0 },
  };
  try {
    await signIn(page, "個人端末", snapshot);
    await recover(page, created.recoveryKey);
    await page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u }).selectOption("US");
    const sparkline = page.locator("tr.selectable").filter({ hasText: "AAPL" }).locator(".ticker-sparkline-wrap");
    await expect(sparkline.locator("svg")).toHaveAttribute("aria-label", /日中価格/u, { timeout: 20_000 });
    await expect(sparkline).not.toContainText("前営業日");
    await expect(sparkline).not.toContainText("値動き待機中");
    await expect(sparkline.locator("polyline")).toHaveAttribute("points", /\S+\s+\S+/u);
  } finally { await environment.cleanup(); }
});

test("cloud US sparkline shows the most recently completed trading session before any new-session data exists", async ({ page }) => {
  const { environment, created } = await seedCloud();
  const currentDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const previous = new Date(`${currentDate}T12:00:00Z`);
  do previous.setUTCDate(previous.getUTCDate() - 1); while (previous.getUTCDay() === 0 || previous.getUTCDay() === 6);
  const previousDate = previous.toISOString().slice(0, 10);
  const previousTimestamp = `${previousDate}T20:00:00.000Z`;
  const bars = [
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T13:30:00.000Z`, price: "220", provider: "fixture" },
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T16:00:00.000Z`, price: "224", provider: "fixture" },
    { securityId: "sec-us-aapl", timestamp: `${previousDate}T20:00:00.000Z`, price: "222", provider: "fixture" },
  ];
  const quotes = [
    { securityId: "sec-us-aapl-xnas", symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price: "222", previousRegularClose: "220", marketTimestamp: previousTimestamp, fetchedAt: previousTimestamp, freshness: "near_live", provider: "fixture", session: "regular", priceType: "regular", venueCode: "US", validationStatus: "valid" },
    { securityId: "sec-fx-usdjpy", symbol: "USDJPY=X", exchangeMic: "FX", currency: "JPY", price: "150", previousRegularClose: "150", marketTimestamp: previousTimestamp, fetchedAt: previousTimestamp, freshness: "near_live", provider: "fixture", session: "regular", priceType: "indicative", venueCode: "FX", validationStatus: "valid" },
  ];
  const snapshot = {
    schemaVersion: 1, generatedAt: previousTimestamp, savedAt: previousTimestamp, marketSessions: [], quotes,
    benchmarks: [{ id: "usd-jpy", label: "USD/JPY", symbol: "USDJPY=X", value: 150, changeRatio: 0, marketTimestamp: previousTimestamp, freshness: "near_live" }],
    intraday: bars, intradayRevision: previousTimestamp,
    coverage: { registered: 2, quoted: 2, fresh: 2, stale: 0, suspect: 0 },
    refresh: { status: "ready", lastRunAt: previousTimestamp, queueMessagesToday: 0, providerCallsToday: 0 },
  };
  try {
    await signIn(page, "個人端末", snapshot);
    await recover(page, created.recoveryKey);
    await page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u }).selectOption("US");
    const sparkline = page.locator("tr.selectable").filter({ hasText: "AAPL" }).locator(".ticker-sparkline-wrap");
    await expect(sparkline.locator("svg")).toHaveAttribute("aria-label", new RegExp(`${Number(previousDate.slice(5, 7))}/${Number(previousDate.slice(8, 10))}`), { timeout: 20_000 });
    await expect(sparkline).not.toContainText("前営業日");
    await expect(sparkline).not.toContainText("値動き待機中");
    await expect(sparkline.locator("polyline")).toHaveAttribute("points", /\S+\s+\S+/u);
  } finally { await environment.cleanup(); }
});

test("verified migration removes the usable cloud key and preserves the encrypted portfolio", async ({ page, applicationErrors }) => {
  const { environment, uid, created } = await seedCloud(true);
  const outgoing: string[] = [];
  let activatedRawKey = "";
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("firestore")) outgoing.push(request.postData() ?? ""); });
  try {
    await signIn(page, "個人端末");
    await expect(page.getByText("保管庫を安全に移行", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("過去の取引・口座・設定は削除せず", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByLabel("新しいパスフレーズ").fill(passphrase);
    await page.getByRole("button", { name: "次へ：復旧キーを作成", exact: true }).click();
    const key = await page.getByLabel("新しい復旧キー", { exact: true }).inputValue({ timeout: 60_000 });
    await page.getByLabel("復旧キーの確認", { exact: true }).fill(key);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "保存したキーを確認して移行" }).click();
    await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 20_000 });
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      expect((await getDoc(doc(db, "users", uid, "keys", "google-account"))).exists()).toBe(false);
      const vault = (await getDoc(doc(db, "users", uid, "vaults", "default"))).data();
      expect(vault?.version).toBe(2);
      const { unlockVaultWithRecoveryKey } = await import("../lib/vault-crypto");
      const unlocked = await unlockVaultWithRecoveryKey<typeof demo>(vault as any, key);
      expect(unlocked.data.transactions).toEqual(demo.transactions);
      activatedRawKey = unlocked.accountKey;
    });
    const writes = outgoing.map((body) => { try { return decodeURIComponent(body.replaceAll("+", " ")); } catch { return body; } }).join("\n");
    expect(writes).not.toMatch(/\b(?:quantity|pricePerShare|grossAmount|costBasis|encodedKey)\b/u);
    expect(activatedRawKey).toHaveLength(43);
    expect(writes).not.toContain(activatedRawKey);
    expect(writes).not.toContain("demo-jp-buy");
    if ("accountKey" in created) expect(writes).not.toContain(created.accountKey);
    await reloadCloud(page, applicationErrors);
    await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 20_000 });
  } finally { await environment.cleanup(); }
});

test("shared-device recovery works with IndexedDB unavailable and leaves no portfolio preferences on disk", async ({ page }) => {
  const { environment, created } = await seedCloud();
  try {
    await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Storage denied", "SecurityError"); } }));
    await signIn(page, "共有端末");
    await recover(page, created.recoveryKey);
    const saved = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
    expect(saved.local.filter((key) => key.startsWith("kabutora"))).toEqual([]);
    expect(saved.session.filter((key) => /watchlist|theme|transactions|accounts|currency|notifications|firebase:authUser/u.test(key))).toEqual([]);
  } finally { await environment.cleanup(); }
});

test("trusted-device startup falls back to recovery when browser storage is unavailable", async ({ page }) => {
  const { environment, created } = await seedCloud();
  try {
    await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Storage denied", "SecurityError"); } }));
    await signIn(page, "個人端末");
    await recover(page, created.recoveryKey);
    await expect(page.locator(".sync-status")).toContainText(/保存できません|保存領域を利用できません/u);
    await expect(page.locator("main.workspace")).toBeVisible();
  } finally { await environment.cleanup(); }
});

test("two trusted devices merge independent preferences and retain encrypted edits while offline", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  const { environment, created } = await seedCloud();
  const secondContext = await browser.newContext({ viewport: page.viewportSize(), isMobile: Boolean(testInfo.project.use.isMobile), hasTouch: Boolean(testInfo.project.use.hasTouch) });
  const second = await secondContext.newPage();
  const failures: string[] = [];
  const offlineFailures: string[] = [];
  const offlineRequests: string[] = [];
  let offline = false;
  second.on("crash", () => failures.push("page crashed"));
  second.on("pageerror", (error) => {
    const expectedEmulatorResume = (error.message.includes("google.firestore.v1.Firestore/Listen/channel?") || error.message.includes("/documents:batchGet?key=demo-emulator-key"))
      && error.message.endsWith("due to access control checks.");
    if (offline && error.message === "WebKit encountered an internal error") offlineFailures.push(error.message);
    else if (expectedEmulatorResume) offlineFailures.push(error.message);
    else failures.push(error.message);
  });
  second.on("console", (item) => {
    if (item.type() !== "error") return;
    const expectedOffline = item.text() === "Failed to load resource: net::ERR_INTERNET_DISCONNECTED"
      || item.text() === "Failed to load resource: WebKit encountered an internal error"
      || /^Beacon API cannot load http:\/\/127\.0\.0\.1:8085\/google\.firestore\.v1\.Firestore\/Listen\/channel\?.*TYPE=terminate.*\. WebKit encountered an internal error$/u.test(item.text());
    const expectedEmulatorResume = (item.text().includes("google.firestore.v1.Firestore/Listen/channel?") || item.text().includes("/documents:batchGet?key=demo-emulator-key"))
      && item.text().endsWith("due to access control checks.");
    if (offline && expectedOffline) offlineFailures.push(item.text());
    else if (expectedEmulatorResume) offlineFailures.push(item.text());
    else failures.push(item.text());
  });
  second.on("response", (response) => { if (/\/api\/|\/_next\//u.test(response.url()) && response.status() >= 400) failures.push(`HTTP ${response.status()}`); });
  second.on("requestfailed", (request) => {
    if (offline && request.url().startsWith("http://127.0.0.1:8085/")) offlineRequests.push(request.url());
    // WebKit also fails fulfilled market routes while the browser is explicitly
    // offline. Only allow the exact transport failure during this outage;
    // application chunks and requests outside it must still fail the test.
    if (offline && new URL(request.url()).pathname.startsWith("/api/market/")
      && /^(?:WebKit encountered an internal error|net::ERR_INTERNET_DISCONNECTED)$/u.test(request.failure()?.errorText ?? "")) {
      offlineFailures.push(`market request: ${request.failure()?.errorText}`);
      return;
    }
    if (/\/api\/|\/_next\//u.test(request.url()) && !/abort|cancel/iu.test(request.failure()?.errorText ?? "")) failures.push(request.failure()?.errorText ?? "request failed");
  });
  for (const route of ["distributions", "registry", "refresh"]) await second.route(`**/api/market/${route}`, (request) => request.fulfill({ json: route === "distributions" ? { distributions: [], coverage: [], failures: [] } : { accepted: 0, queued: 0 } }));
  await second.route("**/api/market/snapshot**", (route) => route.fulfill({ status: 204 }));
  const marketFilter = (target: Page) => target.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  const currencyFilter = (target: Page) => target.getByRole("combobox", { name: "表示通貨", exact: true });
  try {
    await signIn(page, "個人端末");
    await recover(page, created.recoveryKey);
    await signIn(second, "個人端末");
    await second.getByLabel("解除パスフレーズ", { exact: true }).fill(passphrase);
    await second.getByRole("button", { name: "復号して同期を開始" }).click();
    await expect(second.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 60_000 });
    await expect(second.getByText("クラウド同期確認済み", { exact: true })).toHaveCount(1);
    offline = true;
    await secondContext.setOffline(true);
    await currencyFilter(second).selectOption("USD");
    await expect(second.locator(".sync-status")).toContainText("端末に保存済み", { timeout: 10_000 });
    const pending = await second.evaluate(async () => new Promise<any[]>((resolve, reject) => {
      const request = indexedDB.open("kabutora-offline-queue-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("pendingEvents").objectStore("pendingEvents").getAll();
        read.onsuccess = () => { resolve(read.result); db.close(); };
        read.onerror = () => { reject(read.error); db.close(); };
      };
    }));
    expect(pending.length).toBeGreaterThan(0);
    expect(JSON.stringify(pending)).not.toMatch(/displayCurrency|grossAmount|quantity/u);
    expect(pending.every((item) => item.event.payload.ciphertext && item.event.keyId === created.envelope.keyId)).toBe(true);
    await marketFilter(page).selectOption("JP");
    // One 2.5-second scheduler coalesces preference edits before encryption.
    // Wait for the JP event rather than accepting an earlier confirmed state.
    await page.waitForTimeout(3_000);
    await expect(page.getByText("クラウド同期確認済み", { exact: true })).toHaveCount(1);
    await secondContext.setOffline(false);
    offline = false;
    // WebKit's Firestore emulator long-poll listener can remain terminated
    // after setOffline(false). Reopening a trusted tab is the user-visible
    // resume path and must replay both independently encrypted updates.
    await second.reload();
    await expect(second.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 30_000 });
    await expect(second.getByText("クラウド同期確認済み", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await page.reload();
    await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 30_000 });
    await expect(marketFilter(second)).toHaveValue("JP", { timeout: 20_000 });
    await expect(currencyFilter(page)).toHaveValue("USD", { timeout: 20_000 });
    await expect(currencyFilter(second)).toHaveValue("USD");
    await second.getByRole("button", { name: "設定", exact: true }).click();
    await second.getByRole("button", { name: "ロック", exact: true }).click();
    await second.getByRole("alertdialog").getByRole("button", { name: "ロック", exact: true }).click();
    await expect(second.getByText("ポートフォリオはロック中", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "ポートフォリオを開く", exact: true }).click();
    await expect(second.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 20_000 });
    await expect(second.locator(".chart-recovery, .client-recovery, .cloud-error")).toHaveCount(0);
    expect(failures).toEqual([]);
    if (offlineFailures.length) expect(offlineRequests.length, "Expected transport errors must accompany failed emulator requests during the intentional outage").toBeGreaterThan(0);
    await testInfo.attach("expected-offline-transport-failures", { body: JSON.stringify(offlineFailures), contentType: "application/json" });
  } finally {
    // Stop both Firestore listeners before deleting the isolated appAccess
    // fixture. Otherwise WebKit reports the expected permission denial as an
    // unrelated late page error during test teardown.
    await secondContext.close();
    if (!page.isClosed()) await page.close();
    await environment.cleanup();
  }
});

test("restoring a legacy encrypted backup activates a verified fresh generation", async ({ page }) => {
  test.setTimeout(120_000);
  const { environment, created, uid } = await seedCloud();
  const restoredSeed = { ...demo, accounts: demo.accounts.map((account) => ({ ...account, name: `${account.name} 復元済み` })) };
  const backup = await createEncryptedVault(restoredSeed, passphrase);
  try {
    await signIn(page, "個人端末");
    await recover(page, created.recoveryKey);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByLabel("バックアップを復元", { exact: true }).setInputFiles({ name: "legacy-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup.envelope)) });
    await page.getByRole("button", { name: "復旧キー", exact: true }).click();
    await page.getByLabel("解除復旧キー", { exact: true }).fill(backup.recoveryKey);
    await page.getByRole("button", { name: "復号して同期を開始" }).click();
    await page.getByLabel("新しいパスフレーズ").fill(passphrase);
    await page.getByRole("button", { name: "次へ：復旧キーを作成", exact: true }).click();
    const recovery = await page.getByLabel("新しい復旧キー", { exact: true }).inputValue({ timeout: 60_000 });
    await page.getByLabel("復旧キーの確認", { exact: true }).fill(recovery);
    await page.getByRole("button", { name: "保存したキーを確認して移行" }).click();
    await expect(page.locator('[data-startup-state="ready"]')).toBeVisible({ timeout: 30_000 });
    await environment.withSecurityRulesDisabled(async (context) => {
      const vault = (await getDoc(doc(context.firestore(), "users", uid, "vaults", "default"))).data();
      expect(vault?.keyId).not.toBe(created.envelope.keyId);
      const { unlockVaultWithRecoveryKey } = await import("../lib/vault-crypto");
      const unlocked = await unlockVaultWithRecoveryKey<typeof restoredSeed>(vault as any, recovery);
      expect(unlocked.data.accounts).toEqual(restoredSeed.accounts);
      expect(unlocked.data.transactions).toEqual(restoredSeed.transactions);
    });
  } finally { await environment.cleanup(); }
});
