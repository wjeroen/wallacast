// Service Worker for Wallacast PWA
// CACHE_NAME is replaced at build time by the Vite plugin in vite.config.ts
const CACHE_NAME = 'wallacast-v1';

// Install: pre-cache only immutable static assets (not index.html)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll([
          '/manifest.json',
          '/favicon-16x16.png',
          '/favicon-32x32.png',
          '/icon-192.png',
          '/icon-512.png'
        ]);
      })
      .catch((error) => {
        console.error('Cache installation failed:', error);
      })
  );
  // Do NOT call skipWaiting() - let the new service worker wait until
  // all tabs using the old one are closed before taking over.
  // This prevents serving a mix of old and new files.
});

// Activate: clean up old caches, then take control of open pages
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: apply the right caching strategy per request type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests entirely
  if (request.method !== 'GET') {
    return;
  }

  // Audio streams: let the browser handle them natively — do NOT call
  // event.respondWith(). Service-worker-mediated fetch can break byte-range
  // (HTTP 206) seeking on some browsers, causing the audio element to reset
  // to the beginning instead of seeking to the requested position.
  if (url.pathname.match(/\/api\/content\/\d+\/audio/)) {
    return;
  }

  // API calls: pass straight through to the network, never cache.
  // Caching API responses risks serving stale auth data or stale content.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests (HTML pages / SPA routes): network-first.
  // index.html is NOT content-hashed, so we must always fetch the latest
  // version from the network. A stale index.html points to old JS/CSS
  // bundles, which is what caused the "old version after logout" bug.
  // Fall back to cached index.html only when fully offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline fallback only
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Hashed assets (/assets/index-Abc123.js, /assets/index-Xyz.css):
  // cache-first. Vite content-hashes these filenames, so a cached copy
  // is always correct. If the hash changes, it's a new URL — new cache entry.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Other static assets (icons, manifest): network-first with cache fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
