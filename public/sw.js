/**
 * FocusBro Service Worker
 * Handles push notifications, offline support, and caching strategies
 */

const CACHE_NAME = 'focusbro-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ────────────────────────────────────────────────────────
// INSTALLATION & ACTIVATION
// ────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[SW] Some assets failed to cache:', err.message);
          // Don't fail install if some assets can't be cached
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME)
            .map(name => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// ────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  console.log('[SW] Push notification received');
  
  if (!event.data) {
    console.warn('[SW] Push received without data');
    return;
  }

  let notificationData = {};
  try {
    notificationData = event.data.json();
  } catch (e) {
    notificationData = {
      title: 'FocusBro',
      body: event.data.text()
    };
  }

  const options = {
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: notificationData.tag || 'focusbro-notification',
    data: notificationData.data || {},
    ...notificationData // Spread all push data as notification options
  };

  event.waitUntil(
    self.registration.showNotification(notificationData.title || 'FocusBro', options)
      .catch(err => console.error('[SW] Notification display failed:', err.message))
  );
});

// ────────────────────────────────────────────────────────
// NOTIFICATION CLICKS
// ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag);
  event.notification.close();

  const data = event.notification.data || {};
  // Honor an explicit deep-link (data.url) first — e.g. the return nudge → /me/?from=return.
  const targetUrl = data.url || (data.action === 'open' ? `/#${data.view || 'dashboard'}` : '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Try to find an existing window
        for (let client of clientList) {
          if (client.url === new URL(targetUrl, self.location).href && 'focus' in client) {
            return client.focus();
          }
        }
        // If not found, open a new window
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
      .catch(err => console.error('[SW] Notification click handling failed:', err.message))
  );
});

// ────────────────────────────────────────────────────────
// CACHE STRATEGIES
// ────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // API calls: network-first, fall back to offline
  if (event.request.url.includes('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Static assets: cache-first
  if (shouldCacheStatic(event.request.url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Everything else: network-first
  event.respondWith(networkFirst(event.request));
});

/**
 * Cache-first strategy: try cache first, fall back to network
 */
async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] Cache-first failed for:', request.url, err.message);
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Network-first strategy: try network first, fall back to cache
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.log('[SW] Network failed, trying cache for:', request.url);
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/**
 * Determine if a URL should be cached as a static asset
 */
function shouldCacheStatic(url) {
  const staticPatterns = [
    /\.(js|css|woff|woff2|ttf|jpg|jpeg|png|gif|svg|ico)$/i,
    /fonts\.googleapis/,
    /manifest\.json/
  ];
  return staticPatterns.some(pattern => pattern.test(url));
}
