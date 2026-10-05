// FBQ-04a in a real browser: an installed service worker delivers the current
// deploy, never stores /api/*, upgrades from the focusbro-v1 worker, and obeys
// the kill switch. /sw.js is the real Worker route (worker.fetch, real headers);
// the shell and /native-bridge.js are stand-ins stamped with a swappable build.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import worker from '../src/index.js';

let BASE = ''; // an ephemeral port per Playwright worker, so parallel runs never collide
const V1_SW = fs.readFileSync(new URL('./fixtures/sw-focusbro-v1.js', import.meta.url), 'utf8');
const state = { build: 'A', sw: 'current', kill: false };
let server;

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/sw.js') {
      if (state.sw === 'v1') { // what production serves today, header and all
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' });
        return res.end(V1_SW);
      }
      const env = { BUILD_SHA: `build-${state.build}`, SW_KILL_SWITCH: state.kill ? '1' : '' };
      const r = await worker.fetch(new Request(`${BASE}/sw.js`), env, { waitUntil() {} });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(await r.text());
    }
    if (path === '/' || path === '/index.html') {
      // Same Cache-Control as the Worker's shell.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(`<!doctype html><html><head><title>FocusBro</title></head><body><h1 id="build">${state.build}</h1><script src="/native-bridge.js"></script></body></html>`);
    }
    if (path === '/native-bridge.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
      return res.end(`window.__bridge = ${JSON.stringify(state.build)};`);
    }
    if (path === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (path.startsWith('/api/') || path.startsWith('/sync/')) {
      // Deliberately no Cache-Control: the worker itself must refuse to store these.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ build: state.build, secret: 'account-data' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  BASE = `http://localhost:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });
test.beforeEach(() => { Object.assign(state, { build: 'A', sw: 'current', kill: false }); });

const cacheKeys = (page) => page.evaluate(() => caches.keys());
const cachedUrls = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
  return out;
});
const shown = (page) => page.evaluate(() => ({ html: document.getElementById('build').textContent, bridge: window.__bridge }));

/** Register /sw.js and reload until the page is controlled by it. */
async function install(page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('a reload after a deploy serves the new build, and /api/* never lands in Cache Storage', async ({ page }) => {
  await install(page);
  await expect.poll(() => cacheKeys(page)).toEqual(['focusbro-build-A']);
  await page.evaluate(() => Promise.all(['/api/me', '/api/commitments?x=1', '/sync/data'].map((u) => fetch(u).then((r) => r.json()))));

  state.build = 'B';
  await page.reload();
  expect(await shown(page)).toEqual({ html: 'B', bridge: 'B' });
  // the browser's update check installed build B's worker, which deleted A's cache
  await expect.poll(() => cacheKeys(page)).toEqual(['focusbro-build-B']);
  await page.reload(); // now under build B's worker
  expect(await shown(page)).toEqual({ html: 'B', bridge: 'B' });
  await page.evaluate(() => Promise.all(['/api/me', '/sync/data'].map((u) => fetch(u).then((r) => r.json()))));
  const urls = await cachedUrls(page);
  expect(urls).toContain('/native-bridge.js'); // positive control: the cache is in use
  expect(urls.filter((u) => /^\/(api|sync)\//.test(u))).toEqual([]);
});

test('a browser running the focusbro-v1 worker picks up the new build within two reloads', async ({ page }) => {
  state.sw = 'v1';
  await install(page);
  await page.reload(); // v1 now holds the shell cache-first
  await expect.poll(() => cacheKeys(page)).toEqual(['focusbro-v1']);
  expect(await shown(page)).toEqual({ html: 'A', bridge: 'A' });

  state.build = 'B'; state.sw = 'current';
  // Reload 1: the old worker still answers from its cache — but the navigation
  // triggers an update check that fetches /sw.js from the network (the main
  // script bypasses the HTTP cache), so the new worker installs, skipWaits,
  // claims the page, and deletes focusbro-v1.
  await page.reload();
  console.log('[v1 upgrade] reload 1 shows', JSON.stringify(await shown(page)));
  await expect.poll(() => cacheKeys(page)).toEqual(['focusbro-build-B']);
  // Reload 2: network-first from the new worker.
  await page.reload();
  expect(await shown(page)).toEqual({ html: 'B', bridge: 'B' });
  expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toMatch(/\/sw\.js$/);
});

for (const from of ['current', 'v1']) {
  test(`the kill switch unregisters the ${from} worker and empties every cache`, async ({ page }) => {
    state.sw = from;
    await install(page);
    await page.evaluate(() => fetch('/native-bridge.js'));
    await expect.poll(async () => (await cacheKeys(page)).length).toBeGreaterThan(0);

    state.sw = 'current'; state.kill = true; state.build = 'B';
    await page.reload();
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await expect.poll(() => cacheKeys(page)).toEqual([]);
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    expect(await shown(page)).toEqual({ html: 'B', bridge: 'B' });
    expect(await cacheKeys(page)).toEqual([]);
  });
}
