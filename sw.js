/* Recorded service worker.
 *
 * The point is a fast, offline-capable shell — not caching video. API calls,
 * thumbnails, manifests and media always go to the network, because stale
 * streams are worse than no streams.
 */

const VERSION = 'recorded-v1.0.0';
const SHELL = `${VERSION}-shell`;

const PRECACHE = [
  './',
  './index.html',
  './404.html',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/app.js',
  './assets/api.js',
  './assets/player.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve the vendor player or media from cache by accident. dash.js is
  // large and versioned; the browser's HTTP cache does the right thing.
  if (url.pathname.includes('/assets/vendor/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
