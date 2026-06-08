// sw.js — Juice Bets service worker
const CACHE_NAME = 'juicebets-v2';

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

if (url.host === APP_HOST) {
  // Network-first for HTML — always get fresh markup
  if (req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return response;
      }).catch(() => caches.match(req)) // fall back to cache only when offline
    );
    return;
  }
  // Cache-first for everything else (images, icons, manifest)
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
