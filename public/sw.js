/**
 * FocusBro Service Worker
 * Handles push notifications and caching. The Worker serves these bytes with the
 * build-id placeholder below replaced by the deploy's id (BUILD_SHA, else a content
 * hash), so every deploy is a byte-different worker the browser installs, and the
 * old build's cache is deleted on activate (FBQ-04).
 */

const CACHE_NAME = 'focusbro-__FOCUSBRO_BUILD_ID__';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];
// Immutable media: content-hashed audio loops and the brand icons. The only
// cache-first requests; everything else same-origin is network-first.
const CACHE_FIRST = /^\/(audio\/|icon-192\.(png|svg)$|icon-512\.png$|mark\.svg$|og\.png$)/;
// Never stored, never answered from cache: account data, sessions, token links,
// health, the worker itself. /api/ and /sync/ answer a JSON 503 when offline.
const NEVER_CACHE = /^\/(api\/|sync\/|auth\/|health$|sw\.js$|reset-password|verify-email)/;
const OFFLINE_JSON = /^\/(api|sync)\//;
// /me/ is served no-store and shows a signed-in list, so it is never cached:
// offline, a navigation there gets this page, not a copy of someone's list.
const NEEDS_NETWORK = /^\/me(\/|$)/;
const OFFLINE_ME = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Your word — FocusBro</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">' +
  '<h1>Your word</h1><p>Your list needs a connection. It opens again as soon as you are back online.</p>' +
  '<p><a href="/me/">Try again</a> · <a href="/">Open the focus tools</a> (they work offline)</p></body></html>';

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

// Sign-out (FBQ-04 R3): the page asks, every cache goes, then the page hears back.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'focusbro:forget') return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(name => caches.delete(name))))
      .catch(() => {})
      .then(() => { if (port) port.postMessage({ forgotten: true }); })
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
          // Nothing was written (FBQ-01/02): open the word, as the native bridge does.
          if (res && res.recorded === false) return clients.openWindow ? clients.openWindow(data.url || '/me/') : null;
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

// Fetch strategy (FBQ-04): account data and sessions go straight to the network and are
// never stored; immutable media is cache-first; navigations and every other
// same-origin GET are network-first, falling back to the last good copy offline.
function storable(response) {
  return response && response.status === 200 &&
    !/no-store|private/i.test(response.headers.get('Cache-Control') || '');
}
function keep(request, response) {
  if (!storable(response)) return;
  const copy = response.clone();
  caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (NEVER_CACHE.test(url.pathname)) {
    if (!OFFLINE_JSON.test(url.pathname)) return;
    return event.respondWith(
      fetch(request).catch(err => {
        console.warn('SW network fetch failed:', err && err.message || err);
        return new Response(
          JSON.stringify({ error: 'Offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
  }

  if (CACHE_FIRST.test(url.pathname)) {
    return event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        keep(request, response);
        return response;
      }))
    );
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        keep(request, response);
        return response;
      })
      .catch(err => {
        console.warn('SW network fetch failed, serving the last good copy:', err && err.message || err);
        if (request.mode === 'navigate' && NEEDS_NETWORK.test(url.pathname)) {
          return new Response(OFFLINE_ME, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
        }
        return caches.match(request).then(cached => cached ||
          (request.mode === 'navigate' ? caches.match('/').then(shell => shell || Response.error()) : Response.error()));
      })
  );
});
