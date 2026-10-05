/**
 * The service-worker kill switch (FBQ-04 R4).
 *
 * While the Worker has `SW_KILL_SWITCH` set ("1", "true" or "on"), /sw.js serves
 * these bytes instead of public/sw.js. Every installed worker picks them up at its
 * next update check (each navigation, and at least daily on a push), installs them
 * at once, deletes every cache and unregisters itself. It has no fetch handler, so
 * from the moment it activates every request goes straight to the network. The
 * price: push subscriptions die with the registration until the switch is cleared.
 */
export const SW_KILL_SOURCE = `// FocusBro service worker: KILL SWITCH (SW_KILL_SWITCH is set on the Worker).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) { return Promise.all(names.map(function (n) { return caches.delete(n); })); })
      .then(function () { return self.registration.unregister(); })
  );
});
`;

/** True when the operator has thrown the kill switch. */
export function swKillSwitchOn(env) {
  return /^(1|true|on)$/i.test(String((env && env.SW_KILL_SWITCH) || '').trim());
}
