/**
 * FocusBro Service Worker
 * Handles push notifications, offline support, and caching strategies
 */

const CACHE_NAME = 'focusbro-v1';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS)
        .catch(err => {
          // ✅ LOGGING: SW cache failures (e.g., assets unavailable during install)
          console.warn('[SW] Cache install failed:', err.message, '— Will retry on next update');
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let notificationData = {};
  try {
    notificationData = event.data.json();
  } catch (e) {
    notificationData = { title: 'FocusBro', body: event.data.text() };
  }
  const options = {
    icon: '/icon-192.png',
    tag: notificationData.tag || 'focusbro-notification',
    data: notificationData.data || {},
    ...notificationData
  };
  event.waitUntil(
    self.registration.showNotification(notificationData.title || 'FocusBro', options)
  );
});

// Notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // A check-in's buttons answer it right here — no app open needed. "I did it"
  // resolves through the one-tap ticket the payload carried (a service worker
  // has no session) and confirms in the ally's own line; "Not yet" lands on the
  // word with the warm reschedule open. Either way: never dropped on the toolkit.
  if (event.action === 'kept' && data.reply) {
    event.waitUntil(
      fetch('/api/checkins/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: data.reply, outcome: 'kept' })
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('reply ' + r.status)); })
        .then(function (res) {
          return self.registration.showNotification('FocusBro', {
            body: (res && res.message) || 'Kept.',
            tag: event.notification.tag,
            icon: '/icon-192.png',
            data: { type: 'checkin_kept', url: data.url || '/me/' }
          });
        })
        .catch(function () { return clients.openWindow ? clients.openWindow(data.url || '/me/') : null; })
    );
    return;
  }
  if (event.action === 'not-yet') {
    var notYetUrl = (data.url || '/me/') + ((data.url || '').indexOf('?') >= 0 ? '&' : '?') + 'answer=not-yet';
    event.waitUntil(clients.openWindow ? clients.openWindow(notYetUrl) : null);
    return;
  }
  // Honor an explicit deep-link (data.url) first — this is what carries a tapped
  // notification to the right surface (e.g. the return nudge → /me/?from=return).
  // Fall back to the legacy action/view hash, then the app root.
  const targetUrl = data.url || (data.action === 'open' ? `/#${data.view || 'dashboard'}` : '/');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});

// Fetch strategy: network-first for API, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    return event.respondWith(
      fetch(request)
        .then(response => {
          // Clone immediately to avoid consuming the response
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(err => {
          console.warn('SW network fetch failed, falling back to cache:', err && err.message || err);
          return caches.match(request).then(cached => cached || new Response(
            JSON.stringify({ error: 'Offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          ));
        })
    );
  }

  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request)
        .then(response => {
          // Clone immediately to avoid consuming the response
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          }
          return response;
        })
      )
      .catch(err => { console.warn('SW fetch for asset failed, returning index.html from cache:', err && err.message || err); return caches.match('/index.html'); })
  );
});
