// FBQ-23 — frontend polish, verified live 2026-10-05:
//   1. /me/ layout shift (CLS 0.123, over the 0.1 "good" line)
//   2. manifest shortcuts pointed at ?view=, which nothing reads (pinned in vitest: src/__tests__/fbq23-manifest-and-probe.test.js)
//   3. the shell never reached network idle (a 401 on /auth/session is a response
//      Chromium reports but Playwright never sees finish, so any `networkidle`
//      monitor — the Cloud Run browser agent — timed out)
//   4. a 401 console error on every anonymous first visit, and on /me/ for a
//      guest, a 401 on /api/internal/metrics
import { test, expect } from '@playwright/test';

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// No external dependencies: fonts, the service-worker client, the Pro probe and the visit beacon
// are stubbed so the only thing under test is the page's own behaviour.
async function stubShellEdges(page) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.route('https://static.cloudflareinsights.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/sw-client.js', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/api/pro/status', (r) => r.fulfill(json({ pro: false, signedIn: false })));
  await page.route('**/api/acquisition/visit', (r) => r.fulfill(json({ ok: true }, 202)));
}

test.describe('anonymous first visit', () => {
  test('the shell reaches network idle and the console stays clean', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await stubShellEdges(page);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 8000 });
    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('/me/ for an anonymous visitor: idle and no console errors', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await stubShellEdges(page);
    await page.goto('/me/', { waitUntil: 'networkidle', timeout: 8000 });
    await expect(page.locator('#anonNote')).toBeVisible();
    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('/me/ signed in', () => {
  const now = Date.now();
  const word = (i, status) => ({ id: `c${i}`, title: `word ${i}`, status, start_at: new Date(now + i * 36e5).toISOString(), recurrence: i % 2 ? 'daily' : null, next_checkin: new Date(now + i * 36e5).toISOString() });

  // Realistic latency: each read lands at a different moment, which is what
  // makes a page without reserved space move under the reader.
  async function stubMe(page, { founder = false, onMetrics } = {}) {
    await stubShellEdges(page);
    const later = (ms, make) => async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.fulfill(make()); };
    await page.route('**/auth/session*', later(700, () => json({ authenticated: true, guest: false, email: 'a@example.com', founder })));
    await page.route('**/api/commitments', later(150, () => json({ commitments: [word(1, 'active'), word(2, 'active'), word(3, 'kept')] })));
    await page.route('**/api/accountability/streak', later(120, () => json({ streak: { total_kept: 4 }, message: 'You have kept 4 words. That is real.', best: 'A personal best.' })));
    await page.route('**/api/accountability/kept', later(200, () => json({ kept: [{ title: 'a', kept_at: new Date().toISOString() }], message: 'Kept.' })));
    await page.route('**/api/accountability/homecoming', later(100, () => json({ homecoming: true })));
    await page.route('**/api/escalation', later(100, () => json({ ceiling: 'text' })));
    await page.route('**/api/consent', later(100, () => json({ channels: {} })));
    await page.route('**/api/coach/note-consent', later(100, () => json({})));
    await page.route('**/api/coach/links', later(100, () => json({ links: [] })));
    await page.route('**/api/coach/invitations', later(100, () => json({ invitations: [] })));
    await page.route('**/api/internal/metrics*', async (route) => {
      if (onMetrics) onMetrics();
      await route.fulfill(json({ error: 'Unauthorized' }, 401));
    });
  }

  test('CLS stays under 0.1', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await stubMe(page);
    await page.goto('/me/', { waitUntil: 'load' });
    await expect(page.locator('#streakMsg')).toContainText('kept 4 words');
    await expect(page.locator('#list .card').first()).toBeVisible();
    await page.waitForTimeout(800);
    const cls = await page.evaluate(() => window.__cls);
    expect(cls, `CLS ${cls}`).toBeLessThan(0.1);
  });

  test('a signed-in account that is not the founder never probes the founder metrics', async ({ page }) => {
    let metricsCalls = 0;
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await stubMe(page, { onMetrics: () => { metricsCalls += 1; } });
    await page.goto('/me/', { waitUntil: 'networkidle', timeout: 8000 });
    await expect(page.locator('#list .card').first()).toBeVisible();
    expect(metricsCalls).toBe(0);
    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the founder still gets the metrics read', async ({ page }) => {
    let metricsCalls = 0;
    await stubMe(page, { founder: true, onMetrics: () => { metricsCalls += 1; } });
    await page.goto('/me/', { waitUntil: 'load' });
    await expect(page.locator('#list .card').first()).toBeVisible();
    await expect.poll(() => metricsCalls).toBe(1);
  });
});
