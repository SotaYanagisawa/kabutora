const CACHE = "kabutora-shell-v92";
const SHELL = ["/manifest.webmanifest?v=92", "/kabutora-logo.png", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Never put HTML, auth routes, APIs, or hashed Next.js code in the service-worker
  // cache. Mixing those files across releases can cause client-side chunk errors.
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => new Response("オフラインです。接続後に再読み込みしてください。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      }))),
  );
});
