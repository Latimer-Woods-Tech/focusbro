// FBQ-04b in a real browser: the shell registers the service worker by itself,
// / reloads offline, /me/ offline says it needs a connection (never a list),
// sign-out empties Cache Storage and drops the push subscription (server row
// first), and the native app never gets a worker. The served pages are the real
// ones (html.js, renderMePage, the Worker's own script routes); "offline" is the
// server dropping every connection, which is what the worker sees on a plane.
// Push is stubbed at PushManager: headless Chromium has no push service.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import worker from '../src/index.js';
import htmlContent from '../src/html.js';
import { renderMePage } from '../src/me.js';

let BASE = '';
const state = { down: false, hits: [] };
let server;

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (state.down) return req.socket.destroy();
    const path = (req.url || '/').split('?')[0];
    state.hits.push(`${req.method} ${path}`);
    if (['/sw.js', '/sw-client.js', '/native-bridge.js', '/account-delete.js', '/manifest.json'].includes(path)) {
      const r = await worker.fetch(new Request(BASE + path), { BUILD_SHA: 'build-a' }, { waitUntil() {} });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(await r.text());
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(htmlContent);
    }
    if (path === '/me/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderMePage());
    }
    if (path === '/auth/session') { // plain GET: 401 when anonymous; ?probe=1: 200 (FBQ-23)
      const signedIn = /(?:^|;\s*)smoke_session=1/.test(req.headers.cookie || '');
      res.writeHead(signedIn || /probe=1/.test(req.url) ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(signedIn ? { authenticated: true, user_id: 'u1', guest: true } : { authenticated: false }));
    }
    if (path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/notifications/') || path.startsWith('/sync/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (raw) state.hits.push(`${req.method} ${path} ${raw}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); // no Cache-Control: the worker must refuse on its own
        res.end(JSON.stringify({ commitments: [], secret: 'account-data' }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  BASE = `http://localhost:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });
test.beforeEach(() => { state.down = false; state.hits = []; });

const registrations = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
const cachedUrls = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
  return out;
});

/** Load `path` and wait until the page registered the worker ITSELF and is controlled by it. */
async function controlledAt(page, path) {
  await page.goto(BASE + path);
  await expect.poll(() => registrations(page), { timeout: 10000, message: 'the page registered /sw.js' }).toBe(1);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('(a) the shell registers the worker by itself, and an offline reload of / still opens the app', async ({ page }) => {
  await controlledAt(page, '/');
  state.down = true;
  await page.reload();
  await expect(page).toHaveTitle(/FocusBro/);
  await expect(page.locator('#offlinePill')).toHaveCount(1);
  expect((await cachedUrls(page)).filter((u) => /^\/(api|sync|auth)\//.test(u))).toEqual([]);
});

test('(b) offline, /me/ says the list needs a connection — and no copy of /me/ is ever cached', async ({ page, context }) => {
  await context.addCookies([{ name: 'smoke_session', value: '1', url: BASE }]);
  await controlledAt(page, '/me/');
  expect(await cachedUrls(page)).not.toContain('/me/');
  state.down = true;
  await page.reload();
  await expect(page.locator('body')).toContainText('needs a connection');
  await expect(page.locator('a[href="/"]')).toBeVisible();
  await page.click('a[href="/"]'); // the toolkit is the offline promise
  await expect(page).toHaveTitle(/FocusBro/);
});

test('(c) sign-out empties Cache Storage, deactivates the push row on the server, then unsubscribes', async ({ page, context }) => {
  await context.addCookies([{ name: 'smoke_session', value: '1', url: BASE }]);
  await page.addInitScript(() => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e', unsubscribe: async () => { window.__unsubscribed = true; return true; } };
    PushManager.prototype.getSubscription = async () => (window.__unsubscribed ? null : sub);
  });
  await controlledAt(page, '/me/');
  await expect.poll(async () => (await cachedUrls(page)).length).toBeGreaterThan(0); // positive control
  await expect(page.locator('#signout')).toBeVisible();
  await page.click('#signout');
  await expect(page.locator('#signin')).toBeVisible();
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  expect(await page.evaluate(() => window.__unsubscribed)).toBe(true);
  const del = state.hits.findIndex((h) => h.startsWith('DELETE /notifications/subscribe ') && h.includes('fcm/send/e2e'));
  const out = state.hits.indexOf('POST /auth/logout');
  expect(del, state.hits.join('\n')).toBeGreaterThan(-1);
  expect(out).toBeGreaterThan(del);
});

for (const [name, setup] of [
  ['Capacitor', (page) => page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }; })],
  ['the app user-agent', (page) => page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14) FocusBroApp/1.4' });
  })],
]) {
  test(`(d) no worker is registered inside the native app (${name})`, async ({ page }) => {
    await setup(page);
    for (const path of ['/', '/me/']) {
      await page.goto(BASE + path);
      await page.evaluate(() => new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r))));
      await page.evaluate(() => new Promise((r) => requestIdleCallback(() => setTimeout(r, 1500), { timeout: 5000 })));
      expect(await registrations(page)).toBe(0);
      expect(state.hits).not.toContain('GET /sw.js');
    }
  });
}
