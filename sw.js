const CACHE_NAME = "maybell-staff-perf-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./staff-icon-192.png",
  "./staff-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first (with network refresh) for the app shell — HTML/CSS/JS/icons.
// Everything else (Google Sheets CSVs, Google Fonts, PapaParse/Chart.js CDN)
// goes straight to the network untouched, so live data and library updates
// are never served stale.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isAppShell =
    event.request.mode === "navigate" ||
    (url.origin === self.location.origin &&
      APP_SHELL.some((f) => url.pathname.endsWith(f.replace("./", "")) || f === "./"));

  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
