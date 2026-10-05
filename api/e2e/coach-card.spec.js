// FBQ-10 R4 — the "Your coach" card on /me/: stop sharing (with a confirm) and answer an
// invitation, in a real browser, with axe at zero serious/critical violations while it shows.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(page, { links, invitations }, calls) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.route('**/sw-client.js', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/api/pro/status', (r) => r.fulfill(json({ pro: false, signedIn: true })));
  await page.route('**/auth/session*', (r) => r.fulfill(json({ authenticated: true, guest: false, email: 'a@example.com' })));
  await page.route('**/api/commitments', (r) => r.fulfill(json({ commitments: [] })));
  for (const p of ['streak', 'kept', 'homecoming']) await page.route(`**/api/accountability/${p}`, (r) => r.fulfill(json({})));
  await page.route('**/api/escalation', (r) => r.fulfill(json({ ceiling: 'text' })));
  await page.route('**/api/consent', (r) => r.fulfill(json({ channels: {} })));
  await page.route('**/api/coach/note-consent', (r) => r.fulfill(json({ shared: false })));
  await page.route('**/api/coach/links', (r) => r.fulfill(json({ links })));
  await page.route('**/api/coach/invitations', (r) => r.fulfill(json({ invitations })));
  await page.route('**/api/coach/links/*', (r) => { calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return r.fulfill(json({ ok: true })); });
  await page.route('**/api/coach/invitations/*/*', (r) => { calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return r.fulfill(json({ ok: true })); });
}

test('an active link: shown, axe-clean, stop asks first, then ends it', async ({ page }) => {
  const calls = [];
  await stub(page, { links: [{ link_id: 'L1', coach_email: 'sam@example.com' }], invitations: [] }, calls);
  await page.goto('/me/', { waitUntil: 'load' });
  await expect(page.locator('#coachCard')).toBeVisible();
  await expect(page.locator('#coachRows')).toContainText('sam@example.com');

  await page.addScriptTag({ path: AXE });
  const bad = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id));
  expect(bad).toEqual([]);

  const stop = page.getByRole('button', { name: 'Stop sharing with my coach' });
  page.once('dialog', (d) => d.dismiss());
  await stop.click();
  expect(calls).toEqual([]);
  page.once('dialog', (d) => d.accept());
  await stop.click();
  await expect(page.locator('#coachMsg')).toContainText('no longer sees your words');
  expect(calls).toEqual(['DELETE /api/coach/links/L1']);
});

test('a pending invitation: Accept and Decline use the existing endpoints', async ({ page }) => {
  const calls = [];
  await stub(page, { links: [], invitations: [{ link_id: 'I1', coach_email: 'sam@example.com' }] }, calls);
  await page.goto('/me/', { waitUntil: 'load' });
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('#coachMsg')).toContainText('can see your kept-word momentum');
  await page.getByRole('button', { name: 'Decline' }).click();
  await expect(page.locator('#coachMsg')).toContainText('nothing is shared');
  expect(calls).toEqual(['POST /api/coach/invitations/I1/accept', 'POST /api/coach/invitations/I1/decline']);
});
