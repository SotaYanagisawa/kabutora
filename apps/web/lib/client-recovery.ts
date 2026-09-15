export const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_KABUTORA_BUILD_ID ?? "development";

export function isReleaseMismatchError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch module script/i.test(message);
}

export function clientErrorCode(error: unknown) {
  const value = error instanceof Error ? `${error.name}:${error.message}` : String(error ?? "unknown");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `CLIENT-${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export function reloadClient() {
  if (typeof window !== "undefined") window.location.reload();
}

export function repairClientShell() {
  if (typeof window === "undefined") return;
  try { sessionStorage.setItem("kabutora-shell-repaired-at", new Date().toISOString()); } catch { /* Storage may be unavailable in private WebKit contexts. */ }
  const target = `/?shell-repaired=${encodeURIComponent(CLIENT_BUILD_ID)}-${Date.now()}`;
  let redirected = false;
  const redirect = () => {
    if (redirected) return;
    redirected = true;
    window.location.href = target;
  };
  window.setTimeout(redirect, 700);
  const unregister = "serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistrations === "function"
    ? navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister()))).catch(() => undefined)
    : Promise.resolve();
  const clearCaches = "caches" in window
    ? caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("kabutora-shell-")).map((key) => caches.delete(key)))).catch(() => undefined)
    : Promise.resolve();
  void Promise.all([unregister, clearCaches]).finally(redirect);
}

export async function removeLegacyShellWorker() {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem("kabutora-legacy-shell-cleaned") === CLIENT_BUILD_ID) return;
  } catch { /* Continue with an in-memory-safe cleanup. */ }
  const unregister = "serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistrations === "function"
    ? navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister())))
    : Promise.resolve([]);
  const clearCaches = "caches" in window
    ? caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("kabutora-shell-")).map((key) => caches.delete(key))))
    : Promise.resolve([]);
  await Promise.allSettled([unregister, clearCaches]);
  try { sessionStorage.setItem("kabutora-legacy-shell-cleaned", CLIENT_BUILD_ID); } catch { /* No persistent marker available. */ }
}
