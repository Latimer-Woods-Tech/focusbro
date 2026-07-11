/**
 * FocusBro — Web Push subscription intake tests (Contender #10, Phase A).
 *
 * The bug this guards: the intake routes lived in the never-mounted
 * extended-routes.js, so nothing could ever WRITE a push_subscriptions row and
 * every push check-in silently no-op'd. The integration block below drives the
 * real worker and asserts the routes answer 503/401 (mounted) rather than the
 * catch-all 404 (unmounted) — that assertion is the regression fence. The unit
 * block exercises the handler logic (upsert, validation, unsubscribe) without
 * needing real JWT crypto.
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { registerPushRoutes } from '../push-routes.js';

// ── Unit harness: a fake router that captures handlers + a recording DB ──

function fakeRouter() {
  const routes = [];
  const r = {};
  for (const m of ['get', 'post', 'delete', 'put', 'all']) {
    r[m] = (path, handler) => { routes.push({ method: m.toUpperCase(), path, handler }); return r; };
  }
  r.handlerFor = (method, path) => {
    const hit = routes.find((x) => x.method === method && x.path === path);
    return hit && hit.handler;
  };
  return r;
}

function recordingDB() {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      let boundArgs = null;
      const stmt = {
        bind(...args) { boundArgs = args; return stmt; },
        run: async () => { runs.push({ sql, args: boundArgs }); return { success: true }; },
        first: async () => null,
      };
      return stmt;
    },
  };
}

const ctx = {
  getAuthToken: (req) => {
    const h = req.headers.get('Authorization') || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  },
  verifyToken: async (token) => (token === 'good' ? { sub: 'user-1' } : null),
  jsonResponse: (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
  generateUUID: () => 'uuid-fixed',
};

function mount() {
  const router = fakeRouter();
  registerPushRoutes(router, ctx);
  return router;
}

const VALID_SUB = {
  subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'PPP', auth: 'AAA' } },
  device_label: 'Pixel',
};

function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://focusbro.net${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('registerPushRoutes (unit)', () => {
  it('stores a subscription and echoes the id on a valid POST', async () => {
    const router = mount();
    const db = recordingDB();
    const res = await router.handlerFor('POST', '/notifications/subscribe')(post('/notifications/subscribe', VALID_SUB, 'good'), { DB: db, JWT_SECRET: 's' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, subscription_id: 'uuid-fixed' });

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toContain('INSERT INTO push_subscriptions');
    // id, user_id, endpoint, p256dh, auth, device_label
    expect(db.runs[0].args).toEqual(['uuid-fixed', 'user-1', 'https://push.example/abc', 'PPP', 'AAA', 'Pixel']);
  });

  it('rejects an unauthenticated subscribe with 401 and never touches the DB', async () => {
    const router = mount();
    const db = recordingDB();
    const res = await router.handlerFor('POST', '/notifications/subscribe')(post('/notifications/subscribe', VALID_SUB), { DB: db, JWT_SECRET: 's' });
    expect(res.status).toBe(401);
    expect(db.runs).toHaveLength(0);
  });

  it('rejects a malformed subscription body with 400', async () => {
    const router = mount();
    const db = recordingDB();
    const bad = { subscription: { endpoint: 'https://push.example/x' } }; // no keys
    const res = await router.handlerFor('POST', '/notifications/subscribe')(post('/notifications/subscribe', bad, 'good'), { DB: db, JWT_SECRET: 's' });
    expect(res.status).toBe(400);
    expect(db.runs).toHaveLength(0);
  });

  it('serves the VAPID public key only when configured', async () => {
    const router = mount();
    const req = new Request('https://focusbro.net/vapid/public-key');
    const missing = await router.handlerFor('GET', '/vapid/public-key')(req, {});
    expect(missing.status).toBe(503);
    const present = await router.handlerFor('GET', '/vapid/public-key')(req, { VAPID_PUBLIC_KEY: 'BPUB' });
    expect(present.status).toBe(200);
    expect(await present.json()).toEqual({ public_key: 'BPUB' });
  });

  it('soft-deactivates on unsubscribe', async () => {
    const router = mount();
    const db = recordingDB();
    const req = post('/notifications/subscribe', { endpoint: 'https://push.example/abc' }, 'good');
    const del = new Request(req.url, { method: 'DELETE', headers: req.headers, body: JSON.stringify({ endpoint: 'https://push.example/abc' }) });
    const res = await router.handlerFor('DELETE', '/notifications/subscribe')(del, { DB: db, JWT_SECRET: 's' });
    expect(res.status).toBe(200);
    expect(db.runs[0].sql).toContain('is_active = 0');
  });
});

// ── Integration: prove the routes are actually MOUNTED on the real worker ──

function workerEnv(extra = {}) {
  const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
  return { JWT_SECRET: 'test-secret', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt }, ...extra };
}

describe('push intake is reachable on the worker (regression: was 404)', () => {
  it('GET /vapid/public-key answers from the route, not the 404 catch-all', async () => {
    const unconfigured = await worker.fetch(new Request('https://focusbro.net/vapid/public-key'), workerEnv(), {});
    expect(unconfigured.status).toBe(503); // route ran; VAPID just not set

    const configured = await worker.fetch(new Request('https://focusbro.net/vapid/public-key'), workerEnv({ VAPID_PUBLIC_KEY: 'BPUB' }), {});
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ public_key: 'BPUB' });
  });

  it('POST /notifications/subscribe is mounted and gated (401, not 404)', async () => {
    const res = await worker.fetch(
      new Request('https://focusbro.net/notifications/subscribe', { method: 'POST', body: '{}' }),
      workerEnv(),
      {}
    );
    expect(res.status).toBe(401);
  });
});
