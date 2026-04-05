/**
 * Scanny Boi — Service Worker
 * Caches static assets for instant load
 * API calls and HTML document always go to network — never cached
 * Bumping cache version forces old cache wipe on next load
 */
const CACHE_NAME = 'scanny-boi-v5';

// Nothing to pre-cache — assets cached on first load
const SHELL = [];

// Install — activate immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - API calls     → network only, never cache
// - HTML navigate → network only, fall back to cached index.html if offline
// - JS/CSS assets → network first, fall back to cache (never return wrong content)
// - Everything else → cache first, fall back to network
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network for API calls — never intercept
  if (url.pathname.startsWith('/api/')) return;

  // Always network for page navigation
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // JS and CSS — network first, fall back to cache
  // NEVER return index.html as a fallback for scripts — that causes parse errors
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
      // If not in cache either, return a real network error (not index.html)
    );
    return;
  }

  // Cache first for other static assets (fonts, icons, manifest)
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
    })
  );
});
