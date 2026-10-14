const CACHE_NAME = 'mvp-ledger-pwa-v8';
const PRE_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/ledger-book-icon.jpg'
];

// Service Worker Installation: Pre-cache essential app shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching core PWA shell assets and frosted glass ledger book icons');
      return cache.addAll(PRE_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Service Worker Activation: Clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting obsolete cache version:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Interception: Stale-While-Revalidate caching for static assets & offline fallback
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests (e.g. Google Fonts, Google Sheets)
  if (!event.request.url.startsWith(self.location.origin)) return;

  // Exclude API paths and development modules from service worker cache
  if (
    event.request.url.includes('/api/') ||
    event.request.url.includes('/@vite') ||
    event.request.url.includes('/@fs') ||
    event.request.url.includes('/src/') ||
    event.request.url.includes('?t=') ||
    event.request.url.includes('?v=')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        console.warn('[SW] Offline network fetch failed:', err);
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });

      return cachedResponse || fetchPromise;
    })
  );
});

// Background Task: Push Notification received (sent by the server via Web Push)
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'MVP Ledger';
  const options = {
    body: data.body || 'You have a new update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'mvp-ledger',
    renotify: true,
    vibrate: [100, 50, 100],
    data: { url: data.url || '/', open: data.open || null, with: data.with || null }
  };

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // If the app is open and focused the in-app toast already shows it (iOS requires every push to be displayed).
      const isIOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent || '');
      const focused = list.some((c) => c.visibilityState === 'visible' && c.focused);
      if (focused && !isIOS) return;
      return self.registration.showNotification(title, options);
    })
  );
});

// Notification Click Handler: focus the app and deep-link to chat / notices
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'open', open: d.open, with: d.with });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
