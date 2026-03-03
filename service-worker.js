const CACHE_NAME = "autostat-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./script.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((resp) => {
        // Cache same-origin GET requests
        try {
          const url = new URL(event.request.url);
          if (event.request.method === "GET" && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
        } catch (_) {}
        return resp;
      });
    })
  );
});
