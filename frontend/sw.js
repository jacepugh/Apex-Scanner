/**
 * Scanny Boi — Service Worker
 * Caches static assets for instant load
 * API calls and HTML document always go to network — never cached
 * Bumping cache version forces old cache wipe on next load
 */

const CACHE_NAME = 'scanny-boi-v4';

// App shell — fonts and manifest only
// index.html intentionally excluded — always fetched fresh from network
const SHELL = [];

// Install — nothing to pre-cache, activate immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean up old caches (v1, v2, v3)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - API calls       → network only, never cache
// - HTML navigate   → network only, fall back to cache if offline
// - Everything else → cache first, fall back to network (fonts, icons, manifest)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network for API calls
  if (url.pathname.startsWith('/api/')) return;

  // Always network for page navigation — ensures every deploy is live immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache first for static assets (fonts, icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      });
    }).catch(() => caches.match('/index.html'))
  );
});
