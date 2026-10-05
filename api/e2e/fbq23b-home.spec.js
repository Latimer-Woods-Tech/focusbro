// FBQ-23b — two defects found by a LIVE probe of https://focusbro.net/ after FBQ-23 (#419) deployed:
//   1. `/` never reached network idle. The acquisition beacon's response body was never read
//      (only `.ok`), so the browser never reports that request finished and every
//      `networkidle` monitor (the Cloud Run browser agent) times out. #419's spec stubbed the
//      beacon with route.fulfill(), which finishes synchronously and hid it.
//   2. CLS 0.1985 on `/` with the promise-first home.
// Here the beacon goes to the REAL smoke server (e2e/serve.mjs), which answers byte-for-byte
// like prod: 202, content-length 11, application/json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const face = (w, file) => `@font-face{font-family:'DM Sans';font-style:normal;font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/s/dmsans/${file}.ttf) format('truetype')}`;

// Edges stubbed, but NOT the visit beacon: it must hit the real server. The REAL DM Sans files are
// served with a delay so the swap lands after first paint, as it does on prod (it was the CLS).
async function stubEdges(page) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: [400, 500].map((w) => face(w, 'r400')).concat([600, 700].map((w) => face(w, 'r700'))).join('') }));
  await page.route('https://fonts.gstatic.com/s/dmsans/*', async (r) => {
    await new Promise((res) => setTimeout(res, 250));
    const file = r.request().url().includes('r700') ? 'dmsans-700.ttf' : 'dmsans-400.ttf';
    await r.fulfill({ contentType: 'font/ttf', body: fs.readFileSync(path.join(FONTS, file)) });
  });
  await page.route('https://static.cloudflareinsights.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/sw-client.js', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
}

const later = (ms, make) => async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.fulfill(make()); };

async function stubGuest(page, words) {
  const now = Date.now();
  await page.route('**/auth/session*', later(500, () => json({ authenticated: true, guest: true })));
  await page.route('**/api/commitments', later(300, () => json({
    commitments: words.map((title, i) => ({ id: `c${i}`, title, status: 'active', next_checkin: new Date(now + (i + 1) * 36e5).toISOString() })),
  })));
  await page.route('**/api/accountability/streak', later(150, () => json({ streak: { total_kept: 2 } })));
}

async function stubAnon(page) {
  await page.route('**/auth/session*', later(500, () => json({ authenticated: false })));
}

const watchCls = (page) => page.addInitScript(() => {
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
});

test('the shell reaches network idle with the real beacon response, and the beacon still lands with an Origin', async ({ page, request }) => {
  await stubEdges(page);
  await stubAnon(page);
  // Root cause, observed directly: Chromium (under any CDP driver) never reports a response whose body
  // nobody consumed as finished, so `networkidle` never fires. Locally the 11-byte body is delivered with
  // the headers and finishes anyway; on prod (CF edge) it does not. Hold the beacon to the cause.
  await page.addInitScript(() => {
    window.__visitResponses = [];
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const p = realFetch.apply(this, arguments);
      if (String(input).includes('/api/acquisition/visit')) p.then((r) => window.__visitResponses.push(r));
      return p;
    };
  });
  const campaign = `fbq23b-${Date.now()}`; // unique: the smoke server is shared by parallel specs
  const mine = async () => (await (await request.get('/__smoke/visits')).json()).filter((v) => v.campaign === campaign);
  await page.goto(`/?utm_campaign=${campaign}`, { waitUntil: 'networkidle', timeout: 6000 });
  await expect.poll(async () => (await mine()).length).toBe(1);
  expect((await mine())[0].origin).toBe('http://localhost:4173');
  const used = await page.evaluate(() => window.__visitResponses.map((r) => r.bodyUsed));
  expect(used, 'the beacon response body must be read to the end').toEqual([true]);
  // Delivered once and remembered: the funnel counts a session once.
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('focusbro_visit:')).length)).toBe(1);
});

// The live probe and the Cloud Run browser agent are a plain 390x844 Chromium, not a Pixel 5 emulation.
test.use({ viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

for (const home of ['promise', 'toolkit']) {
  const scenarios = {
    'anonymous': (page) => stubAnon(page),
    'signed-in guest with words': (page) => stubGuest(page, ['Send the invoice', 'Call the dentist', 'Reply to Sam']),
    'signed-in guest with none': (page) => stubGuest(page, []),
  };
  for (const [name, stub] of Object.entries(scenarios)) {
    test(`CLS stays under 0.1 on / (${home}, ${name})`, async ({ page }) => {
      await watchCls(page);
      await stubEdges(page);
      await stub(page);
      await page.goto(`/?home=${home}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const cls = await page.evaluate(() => window.__cls);
      expect(cls, `CLS ${cls}`).toBeLessThan(0.1);
    });
  }
}
