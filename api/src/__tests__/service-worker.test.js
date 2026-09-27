/**
 * FocusBro — the served service worker must EVALUATE.
 *
 * /sw.js is a template string inside the Worker. It shipped with a syntax
 * error (an arrow-function block never closed before the catch's parenthesis),
 * so every registration failed with "ServiceWorker script evaluation failed"
 * and pushManager.subscribe could never run — push_subscriptions stayed at
 * zero rows for the life of the product, and every push check-in was
 * skipped. This fetches the bytes the Worker serves, parses them, and runs
 * them in a service-worker-shaped sandbox. FAILS on the tree with the error.
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import worker from '../index.js';

async function servedSw() {
  const res = await worker.fetch(new Request('https://focusbro.net/sw.js'), { BUILD_SHA: 'abc' }, {});
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/javascript/);
  return res.text();
}

describe('/sw.js', () => {
  it('parses, and evaluates in a service-worker-shaped global with push and click handlers registered', async () => {
    const src = await servedSw();
    expect(() => new Function(src)).not.toThrow();
    const listeners = {};
    const self = {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      registration: { showNotification: async () => {} },
      clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => {} },
      skipWaiting: async () => {},
      location: { origin: 'https://focusbro.net' },
    };
    const ctx = {
      self, console, URL, Response, Request, Headers, setTimeout, clearTimeout,
      caches: { open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => null }), keys: async () => [], delete: async () => true, match: async () => null },
      fetch: async () => new Response('{}'),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    expect(() => vm.runInContext(src, ctx, { filename: 'sw.js' })).not.toThrow();
    for (const type of ['install', 'activate', 'fetch', 'push', 'notificationclick']) expect(listeners[type], type).toBeTypeOf('function');
  });

  it('falls back to the cache, then to an offline response, when the network fails', async () => {
    const src = await servedSw();
    expect(src).toContain("caches.match(request).then(cached => cached || new Response(");
  });
});
