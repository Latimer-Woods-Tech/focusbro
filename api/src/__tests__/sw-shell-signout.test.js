/**
 * FBQ-04b — the service worker is registered on the shell (R5), sign-out forgets
 * the device (R3), and a one-tap answer that wrote nothing opens the word (the
 * FBQ-02 follow-up).
 *
 * Before: only the push opt-in on /me/ ever registered /sw.js, so "offline" was a
 * claim with no worker behind it; offline, /me/ fell back to a copy of the shell;
 * sign-out left Cache Storage, the push subscription (browser and server row) and
 * the phone's scheduled check-ins in place for the next person on the device; and
 * a `recorded:false` ticket answer showed "already logged" instead of the word.
 * The browser half is proven in e2e/sw-shell-offline.spec.js.
 */
import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import worker from '../index.js';
import servedHtml from '../html.js';
import { renderMePage } from '../me.js';
import { ACCOUNT_DELETE_SCRIPT } from '../account-delete.js';
import { NATIVE_BRIDGE_SCRIPT } from '../native-bridge.js';
import { scanDesignLaw } from '../design-law.js';

const ORIGIN = 'https://focusbro.net';
const get = (path, env = { BUILD_SHA: 'build-a' }) => worker.fetch(new Request(ORIGIN + path), env, { waitUntil() {} });

/** The served /sw.js in a service-worker-shaped sandbox (Cache Storage in memory). */
async function bootSw({ network = () => new Response('net'), seed = {} } = {}) {
  const src = await (await get('/sw.js')).text();
  const store = new Map(Object.entries(seed).map(([n, e]) => [n, new Map(Object.entries(e))]));
  const keyOf = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const caches = {
    open: async (n) => { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n); return { put: async (q, r) => { m.set(keyOf(q), r); }, addAll: async () => {}, match: async (q) => m.get(keyOf(q)) }; },
    keys: async () => [...store.keys()],
    delete: async (n) => store.delete(n),
    match: async (q) => { for (const m of store.values()) if (m.has(keyOf(q))) return m.get(keyOf(q)).clone(); return undefined; },
  };
  const listeners = {};
  const clients = { matchAll: async () => [], openWindow: vi.fn(async () => {}), claim: async () => {} };
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, registration: { showNotification: vi.fn(async () => {}) }, clients, skipWaiting: async () => {}, location: { origin: ORIGIN } };
  const ctx = { self, clients, caches, console: { warn() {} }, URL, Response, Request, Headers, setTimeout, fetch: async (q) => { const r = network(q); if (r instanceof Error) throw r; return r; } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const run = async (type, extra) => {
    let p = null; let out;
    listeners[type]({ ...extra, waitUntil: (x) => { p = x; }, respondWith: (x) => { out = x; } });
    if (p) await p;
    return out === undefined ? undefined : await out;
  };
  return { listeners, store, run, clients, self };
}

describe('the worker side', () => {
  it('a forget message deletes every cache and answers on the port', async () => {
    const sw = await bootSw({ seed: { 'focusbro-build-a': { '/': new Response('shell') }, 'focusbro-v1': {} } });
    expect(typeof sw.listeners.message).toBe('function');
    const port = { postMessage: vi.fn() };
    await sw.run('message', { data: { type: 'focusbro:forget' }, ports: [port] });
    expect([...sw.store.keys()]).toEqual([]);
    expect(port.postMessage).toHaveBeenCalledWith({ forgotten: true });
  });

  it('offline, /me/ answers a needs-a-connection page — never the shell, never a list', async () => {
    const sw = await bootSw({ seed: { 'focusbro-build-a': { '/': new Response('SHELL') } }, network: () => new Error('offline') });
    const req = new Request(`${ORIGIN}/me/?word=w1`);
    Object.defineProperty(req, 'mode', { value: 'navigate' });
    const res = await sw.run('fetch', { request: req });
    const html = await res.text();
    expect(html).not.toBe('SHELL');
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('needs a connection');
    const copy = html.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter((s) => s.length > 1);
    for (const line of copy) expect(scanDesignLaw(line), line).toEqual([]);
  });

  it('a one-tap answer that recorded nothing opens the word instead of "already logged"', async () => {
    const sw = await bootSw({ network: () => new Response(JSON.stringify({ message: 'Got this one already.', recorded: false }), { status: 200 }) });
    await sw.run('notificationclick', { action: 'kept', notification: { close() {}, tag: 't', data: { reply: 'tk', url: '/me/?word=w1' } } });
    expect(sw.clients.openWindow).toHaveBeenCalledWith('/me/?word=w1');
    expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('a recorded answer still confirms in the notification', async () => {
    const sw = await bootSw({ network: () => new Response(JSON.stringify({ message: 'Kept.', recorded: true }), { status: 200 }) });
    await sw.run('notificationclick', { action: 'kept', notification: { close() {}, tag: 't', data: { reply: 'tk', url: '/me/?word=w1' } } });
    expect(sw.self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });
});

/** Run the served /sw-client.js against a stub window. */
async function bootClient({ native = false, attr = false, ua = 'Mozilla/5.0', forgetOnly = false, sub = true, sw = true } = {}) {
  const res = await get('/sw-client.js');
  expect(res.status).toBe(200);
  const src = await res.text();
  const calls = [];
  const loads = [];
  const subscription = sub ? { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', unsubscribe: vi.fn(async () => true) } : null;
  const active = { postMessage: vi.fn((msg, [port]) => { calls.push(['message', msg.type]); port.onmessage && setTimeout(() => port.onmessage({ data: {} }), 0); }) };
  const reg = { active, pushManager: { getSubscription: async () => subscription } };
  const win = {
    document: { readyState: 'loading', currentScript: { hasAttribute: (a) => forgetOnly && a === 'data-forget-only' }, documentElement: { hasAttribute: (a) => attr && a === 'data-native-app' } },
    navigator: { userAgent: ua, serviceWorker: sw ? { register: vi.fn(async () => reg), getRegistration: async () => reg, controller: active } : undefined },
    addEventListener: (t, fn) => { if (t === 'load') loads.push(fn); },
    requestIdleCallback: (fn) => fn(),
    setTimeout, MessageChannel: class { constructor() { this.port1 = {}; this.port2 = this.port1; } },
    caches: { keys: async () => ['focusbro-build-a'], delete: vi.fn(async () => true) },
    sessionStorage: { removeItem: vi.fn() },
    fetch: vi.fn(async (url, init) => { calls.push([init.method, url, JSON.parse(init.body).endpoint]); return { ok: true }; }),
    FocusBroNative: native ? { clear: vi.fn(async () => {}) } : undefined,
    Capacitor: native ? { isNativePlatform: () => true } : undefined,
  };
  new Function('window', src)(win);
  loads.forEach((fn) => fn());
  return { win, calls, subscription, active };
}

describe('the page side (/sw-client.js)', () => {
  it('registers /sw.js after load in a browser', async () => {
    const { win } = await bootClient();
    expect(win.navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('never registers inside the native app, by any of its three markers', async () => {
    for (const opts of [{ native: true }, { attr: true }, { ua: 'Mozilla/5.0 FocusBroApp/1.4' }]) {
      const { win } = await bootClient(opts);
      expect(win.navigator.serviceWorker.register, JSON.stringify(opts)).not.toHaveBeenCalled();
    }
  });

  it('the coach view loads it for sign-out only', async () => {
    const { win } = await bootClient({ forgetOnly: true });
    expect(win.navigator.serviceWorker.register).not.toHaveBeenCalled();
    expect(typeof win.FocusBroSW.forget).toBe('function');
  });

  it('forget(): the worker clears its caches, the server row goes BEFORE the browser unsubscribes', async () => {
    const { win, calls, subscription } = await bootClient();
    await win.FocusBroSW.forget({ Authorization: 'Bearer t' });
    expect(calls).toContainEqual(['message', 'focusbro:forget']);
    expect(calls).toContainEqual(['DELETE', '/notifications/subscribe', subscription.endpoint]);
    expect(win.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(win.fetch.mock.invocationCallOrder[0]).toBeLessThan(subscription.unsubscribe.mock.invocationCallOrder[0]);
    expect(win.caches.delete).toHaveBeenCalledWith('focusbro-build-a');
    expect(win.sessionStorage.removeItem).toHaveBeenCalledWith('focusbro_push_asked');
  });

  it('forget() clears the native schedule, and resolves with no worker at all', async () => {
    const { win } = await bootClient({ native: true, sw: false });
    await win.FocusBroSW.forget({});
    expect(win.FocusBroNative.clear).toHaveBeenCalled();
  });
});

describe('every surface loads it, every sign-out path calls it', () => {
  it('the shell and /me/ load /sw-client.js; /me/ and the coach sign-out forget before /auth/logout', async () => {
    expect(servedHtml).toContain('<script src="/sw-client.js" defer></script>');
    const me = renderMePage();
    expect(me).toContain('<script src="/sw-client.js" defer></script>');
    const signout = me.slice(me.indexOf("el('signout').addEventListener"));
    expect(signout.indexOf('FocusBroSW.forget')).toBeGreaterThan(-1);
    expect(signout.indexOf('FocusBroSW.forget')).toBeLessThan(signout.indexOf("'/auth/logout'"));
    const coach = await (await get('/coach/')).text();
    expect(coach).toContain('<script src="/sw-client.js" data-forget-only defer></script>');
    expect(coach.indexOf('FocusBroSW.forget')).toBeLessThan(coach.indexOf("fetch('/auth/logout'"));
    expect(coach.indexOf('FocusBroSW.forget')).toBeGreaterThan(-1);
  });

  it('a deleted account forgets the device before leaving the page', () => {
    const at = ACCOUNT_DELETE_SCRIPT.indexOf('FocusBroSW.forget');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(ACCOUNT_DELETE_SCRIPT.indexOf('location.assign'));
  });

  it('the native bridge exposes clear(), which cancels every scheduled check-in', async () => {
    const LN = { getPending: async () => ({ notifications: [{ id: 1, extra: { fb: 'checkin' } }, { id: 2 }] }), cancel: vi.fn(async () => {}), addListener: async () => {} };
    const win = {
      document: { documentElement: { setAttribute() {} }, addEventListener() {}, querySelectorAll: () => [] },
      navigator: {}, console: { warn() {} }, fetch: async () => ({ ok: false, status: 500 }), setTimeout: () => 0, clearTimeout() {},
      localStorage: { getItem: () => null, setItem() {} }, location: { origin: ORIGIN },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { LocalNotifications: LN } },
    };
    new Function('window', NATIVE_BRIDGE_SCRIPT)(win);
    expect(typeof win.FocusBroNative.clear).toBe('function');
    await win.FocusBroNative.clear();
    expect(LN.cancel).toHaveBeenCalledWith({ notifications: [{ id: 1 }, { id: 2 }] });
  });
});
