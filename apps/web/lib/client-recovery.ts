export function repairClientShell() {
  if (typeof window === "undefined") return;
  sessionStorage.setItem("kabutora-shell-repaired-at", new Date().toISOString());
  const target = `/?shell-repaired=v60-${Date.now()}`;
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
