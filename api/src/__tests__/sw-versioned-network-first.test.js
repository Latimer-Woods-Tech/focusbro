/**
 * FBQ-04a — the live service worker delivers the current deploy (R1, R2, R4).
 *
 * Before: the cache was named `focusbro-v1` forever and every non-API GET was
 * cache-first, so a browser that once registered the worker kept the shell it
 * first saw; authenticated /api/* (and /sync/*) GETs were written to Cache
 * Storage; /sw.js itself was HTTP-cached for an hour; and there was no way to
 * switch the worker off. These run the SERVED /sw.js in a service-worker-shaped
 * sandbox with an in-memory Cache Storage and a scripted network.
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import worker from '../index.js';

const ORIGIN = 'https://focusbro.net';

async function served(env = { BUILD_SHA: 'build-a' }) {
  const res = await worker.fetch(new Request(`${ORIGIN}/sw.js`), env, { waitUntil() {} });
  expect(res.status).toBe(200);
  return { res, src: await res.text() };
}

/** Evaluate a worker source against a fake Cache Storage and a scripted network. */
function boot(src, { network = () => new Response('net', { status: 200 }), seed = {} } = {}) {
  const store = new Map(); // cacheName -> Map(path -> Response)
  for (const [name, entries] of Object.entries(seed)) store.set(name, new Map(Object.entries(entries)));
  const keyOf = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      put: async (req, res) => { m.set(keyOf(req), res); },
      addAll: async (list) => { for (const p of list) m.set(p, new Response('precached ' + p)); },
      match: async (req) => m.get(keyOf(req))?.clone(),
    };
  };
  const caches = {
    open,
    keys: async () => [...store.keys()],
    delete: async (n) => store.delete(n),
    match: async (req) => { for (const m of store.values()) if (m.has(keyOf(req))) return m.get(keyOf(req)).clone(); return undefined; },
  };
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0, unregister: 0 };
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    registration: { showNotification: async () => {}, unregister: async () => { calls.unregister++; return true; } },
    clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => { calls.claim++; } },
    skipWaiting: async () => { calls.skipWaiting++; },
    location: { origin: ORIGIN },
  };
  const ctx = {
    self, console: { warn() {}, log() {} }, URL, Response, Request, Headers, setTimeout, clearTimeout, caches,
    fetch: async (req) => { const r = network(req); if (r instanceof Error) throw r; return r; },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'sw.js' });
  const run = async (type, extra = {}) => {
    let p = null; let responded;
    listeners[type]({ ...extra, waitUntil: (x) => { p = x; }, respondWith: (x) => { responded = x; } });
    if (p) await p;
    return responded === undefined ? undefined : await responded;
  };
  const get = async (path, mode = 'cors') => {
    const request = new Request(ORIGIN + path);
    Object.defineProperty(request, 'mode', { value: mode });
    const out = await run('fetch', { request });
    await new Promise((r) => setTimeout(r, 0)); // let the background cache.put land
    return out;
  };
  const cached = () => Object.fromEntries([...store].map(([n, m]) => [n, [...m.keys()]]));
  return { listeners, calls, store, run, get, cached };
}

describe('R1 · the cache is named by the build', () => {
  it('the served bytes change when the build changes, and name the cache after it', async () => {
    const a = (await served({ BUILD_SHA: 'build-a' })).src;
    const b = (await served({ BUILD_SHA: 'build-b' })).src;
    expect(a).not.toBe(b);
    const sw = boot(b);
    await sw.run('install');
    expect(Object.keys(sw.cached())).toEqual(['focusbro-build-b']);
  });

  it('without a BUILD_SHA the build-time content hash names it — never a constant', async () => {
    const { swContentHash } = await import('../sw-source.js');
    expect(swContentHash).toMatch(/^[0-9a-f]{16}$/);
    expect((await served({})).src).toContain(`'focusbro-${swContentHash}'`);
    expect((await served({ BUILD_SHA: 'development' })).src).toContain(`'focusbro-${swContentHash}'`);
  });

  it('a hostile build id cannot break out of the string literal', async () => {
    expect((await served({ BUILD_SHA: "x';alert(1)//" })).src).toContain("'focusbro-xalert1'");
  });

  it('activate deletes every other cache (focusbro-v1 included), then skipWaiting + claim', async () => {
    const sw = boot((await served({ BUILD_SHA: 'build-b' })).src, {
      seed: { 'focusbro-v1': { '/': new Response('old') }, 'focusbro-build-a': {}, 'focusbro-build-b': {} },
    });
    await sw.run('install');
    await sw.run('activate');
    expect(Object.keys(sw.cached())).toEqual(['focusbro-build-b']);
    expect(sw.calls.skipWaiting).toBe(1);
    expect(sw.calls.claim).toBe(1);
  });
});

describe('R2 · network-first for the app, never a cached account response', () => {
  const stale = () => ({ 'focusbro-build-a': {
    '/': new Response('STALE SHELL'), '/native-bridge.js': new Response('STALE BRIDGE'),
    '/api/me': new Response('{"stale":true}'), '/sync/data': new Response('{"stale":true}'),
  } });
  const fresh = (req) => new Response('FRESH ' + new URL(req.url).pathname, { status: 200 });

  it('a navigation is answered by the network even when a copy is cached', async () => {
    const sw = boot((await served()).src, { seed: stale(), network: fresh });
    expect(await (await sw.get('/', 'navigate')).text()).toBe('FRESH /');
  });

  it('a same-origin script is network-first too', async () => {
    const sw = boot((await served()).src, { seed: stale(), network: fresh });
    expect(await (await sw.get('/native-bridge.js')).text()).toBe('FRESH /native-bridge.js');
    expect(await (await sw.get('/account-delete.js')).text()).toBe('FRESH /account-delete.js');
    // and the fresh copy is what is kept for offline
    expect(sw.cached()['focusbro-build-a']).toContain('/native-bridge.js');
  });

  it('offline, a navigation falls back to the last good copy, and an unknown page to the shell', async () => {
    const sw = boot((await served()).src, { seed: stale(), network: () => new Error('offline') });
    expect(await (await sw.get('/', 'navigate')).text()).toBe('STALE SHELL');
    expect(await (await sw.get('/guides/', 'navigate')).text()).toBe('STALE SHELL');
  });

  it('/api/* and /sync/* GETs are never written to Cache Storage', async () => {
    const sw = boot((await served()).src, { network: fresh });
    for (const p of ['/api/me', '/api/commitments?x=1', '/sync/data', '/auth/session', '/health']) await sw.get(p);
    const all = Object.values(sw.cached()).flat();
    expect(all.filter((p) => /^\/(api|sync|auth|health)/.test(p))).toEqual([]);
  });

  it('/api/* and /sync/* are never answered from a cache, even offline (a JSON 503 instead)', async () => {
    const sw = boot((await served()).src, { seed: stale(), network: () => new Error('offline') });
    for (const p of ['/api/me', '/sync/data']) {
      const r = await sw.get(p);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'Offline', offline: true });
    }
  });

  it('a response the server marked no-store is not kept', async () => {
    const sw = boot((await served()).src, { network: () => new Response('me', { headers: { 'Cache-Control': 'no-store' } }) });
    await sw.get('/me/', 'navigate');
    expect(Object.values(sw.cached()).flat()).not.toContain('/me/');
  });

  it('immutable media (content-hashed audio, icons) stays cache-first', async () => {
    let hits = 0;
    const sw = boot((await served()).src, {
      seed: { 'focusbro-build-a': { '/audio/rain.0123456789.m4a': new Response('CACHED AUDIO'), '/icon-192.png': new Response('CACHED ICON') } },
      network: () => { hits++; return new Response('NET'); },
    });
    expect(await (await sw.get('/audio/rain.0123456789.m4a')).text()).toBe('CACHED AUDIO');
    expect(await (await sw.get('/icon-192.png')).text()).toBe('CACHED ICON');
    expect(hits).toBe(0);
  });

  it('cross-origin and non-GET requests are left to the browser', async () => {
    const sw = boot((await served()).src);
    const out = await sw.run('fetch', { request: new Request('https://example.com/font.woff2') });
    expect(out).toBeUndefined();
    const post = await sw.run('fetch', { request: new Request(`${ORIGIN}/api/checkins/reply`, { method: 'POST', body: '{}' }) });
    expect(post).toBeUndefined();
  });
});

describe('R4 · the kill switch, and an update check that is never stale', () => {
  it('/sw.js is never HTTP-cached', async () => {
    const { res } = await served();
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    expect(res.headers.get('cache-control')).not.toMatch(/max-age=[1-9]/);
  });

  it('SW_KILL_SWITCH serves a worker that empties every cache and unregisters itself', async () => {
    const { src } = await served({ BUILD_SHA: 'build-b', SW_KILL_SWITCH: '1' });
    const sw = boot(src, { seed: { 'focusbro-v1': { '/': new Response('x') }, 'focusbro-build-a': {} } });
    await sw.run('install');
    await sw.run('activate');
    expect(sw.cached()).toEqual({});
    expect(sw.calls.unregister).toBe(1);
    expect(sw.calls.skipWaiting).toBe(1);
    expect(sw.listeners.fetch).toBeUndefined();
  });

  it('the switch is off unless explicitly thrown', async () => {
    for (const v of [undefined, '', '0', 'false', 'off']) {
      const { src } = await served({ BUILD_SHA: 'b', SW_KILL_SWITCH: v });
      expect(src).toContain("self.addEventListener('push'");
    }
  });
});

describe('push and notification actions are untouched', () => {
  it('the push + notificationclick handlers are byte-identical to the focusbro-v1 worker', async () => {
    const region = (s) => s.slice(s.indexOf('// Push notifications'), s.indexOf('// Fetch strategy'));
    const v1 = readFileSync(new URL('../../e2e/fixtures/sw-focusbro-v1.js', import.meta.url), 'utf8');
    const { src } = await served();
    expect(region(v1).length).toBeGreaterThan(1000);
    expect(region(src)).toBe(region(v1));
  });
});
