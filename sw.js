// sw.js — Juice Bets service worker
const CACHE_NAME = 'juicebets-v1';

// App shell — same-origin assets we always want available offline
const SHELL = [
  '/bet-dashboard/',
  '/bet-dashboard/index.html',
  '/bet-dashboard/manifest.json',
  '/bet-dashboard/snackbar.png',
  '/bet-dashboard/timbo.png',
  '/bet-dashboard/pepe.png',
  '/bet-dashboard/apple-touch-icon.png'
];

const API_HOST = 'script.google.com';
const APP_HOST = self.location.host;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // POST etc. (e.g. submitAllBets) — never intercept
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ---- Apps Script API: stale-while-revalidate ----
  if (url.host === API_HOST) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(cached => {
          const networkFetch = fetch(req).then(response => {
            if (response && response.ok) cache.put(req, response.clone());
            return response;
          }).catch(() => cached); // fall back to cached when offline
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // ---- Same-origin assets (HTML, images, manifest): cache-first ----
  if (url.host === APP_HOST) {
    event.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          }
          return response;
        })
      )
    );
    return;
  }

  // ---- Cross-origin CDN libs (chart.js, confetti, fonts): cache-first ----
  event.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(response => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return response;
      }).catch(() => cached)
    )
  );
});
