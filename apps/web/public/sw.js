/* Orquestador service worker: app shell offline, network-first for the API (never caches mutations or auth). */
const VERSION = "orq-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    // Read-only data screens keep working with the last answer; auth, streams and downloads are never cached.
    const cacheable = /^\/api\/v1\/(dashboard\/kpis|query\/entities|tasks|flows|forms|alerts|alert-rules)(\?|$|\/)/.test(url.pathname) && !url.pathname.includes("/stream");
    if (!cacheable) return;
    event.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.match(req).then((hit) => hit ?? Response.error())));
    return;
  }
  // Navigations fall back to the cached shell so the app opens offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok && /\.(js|css|svg|woff2?)$/.test(url.pathname)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })));
});
