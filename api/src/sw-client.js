/**
 * /sw-client.js — the page half of the service worker (FBQ-04 R3, R5).
 *
 * 1. Registers /sw.js on the app shell and /me/, after `load` and when the
 *    browser is idle, so it never competes with first paint. That is what makes
 *    offline real: the worker keeps the last good shell, and /me/ answers with a
 *    "needs a connection" page instead of an error (see public/sw.js).
 * 2. Exposes `window.FocusBroSW.forget(headers)`, which every sign-out and the
 *    account delete call: it asks the worker to delete every cache, deactivates
 *    the push subscription on the server, unsubscribes it in the browser, and
 *    clears the native app's scheduled check-ins. It never rejects and gives up
 *    after 3 s, so signing out never waits on it.
 *
 * Never registered inside the native app (Capacitor, remote-URL mode): the app
 * reminds through local notifications, not web push, and a worker would answer
 * the shell's requests before Capacitor's own request handling does, which is
 * where the native bridge reaches the page. The app's offline story is native.
 *
 * `<script src="/sw-client.js" data-forget-only>` loads only (2) — the coach view.
 * Every global is reached through `window` so the tests can run it on a stub.
 */
export const SW_CLIENT_SCRIPT = `(function () {
  'use strict';
  var w = window, d = w.document, n = w.navigator || {};
  var me = d.currentScript;
  function noop() {}
  function isNative() {
    var C = w.Capacitor;
    if (C && typeof C.isNativePlatform === 'function' && C.isNativePlatform()) return true;
    if (d.documentElement && d.documentElement.hasAttribute('data-native-app')) return true;
    return /\\bFocusBroApp\\//.test(n.userAgent || '');
  }
  function register() {
    if (!n.serviceWorker || typeof n.serviceWorker.register !== 'function' || isNative()) return;
    n.serviceWorker.register('/sw.js').catch(noop);
  }
  function start() {
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(register, { timeout: 5000 });
    else w.setTimeout(register, 1000);
  }
  if (!(me && me.hasAttribute && me.hasAttribute('data-forget-only'))) {
    if (d.readyState === 'complete') start(); else w.addEventListener('load', start);
  }

  function clearCaches() {
    if (!w.caches || typeof w.caches.keys !== 'function') return Promise.resolve();
    return w.caches.keys().then(function (names) { return Promise.all(names.map(function (k) { return w.caches.delete(k); })); });
  }
  function askWorker(reg) {
    var target = reg.active || (n.serviceWorker && n.serviceWorker.controller);
    if (!target || typeof w.MessageChannel !== 'function') return Promise.resolve();
    return new Promise(function (done) {
      var ch = new w.MessageChannel();
      ch.port1.onmessage = function () { done(); };
      target.postMessage({ type: 'focusbro:forget' }, [ch.port2]);
      w.setTimeout(done, 2000);
    });
  }
  function dropPush(reg, headers) {
    if (!reg.pushManager) return Promise.resolve();
    return reg.pushManager.getSubscription().then(function (sub) {
      if (!sub) return;
      var h = { 'Content-Type': 'application/json' };
      for (var k in (headers || {})) if (k.toLowerCase() !== 'content-type') h[k] = headers[k];
      // The server row first, while the session still exists (the route is authed).
      return w.fetch('/notifications/subscribe', {
        method: 'DELETE', credentials: 'same-origin', headers: h, body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(noop).then(function () { return sub.unsubscribe(); });
    });
  }
  function forget(headers) {
    var jobs = [clearCaches().catch(noop)];
    var N = w.FocusBroNative;
    if (N && typeof N.clear === 'function') jobs.push(Promise.resolve().then(function () { return N.clear(); }).catch(noop));
    try { w.sessionStorage.removeItem('focusbro_push_asked'); } catch (e) {}
    if (n.serviceWorker && typeof n.serviceWorker.getRegistration === 'function') {
      jobs.push(n.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) return;
        return Promise.all([askWorker(reg).catch(noop), dropPush(reg, headers).catch(noop)]);
      }).catch(noop));
    }
    return Promise.race([
      Promise.all(jobs).then(noop, noop),
      new Promise(function (done) { w.setTimeout(done, 3000); })
    ]);
  }
  w.FocusBroSW = { forget: forget };
})();
`;
