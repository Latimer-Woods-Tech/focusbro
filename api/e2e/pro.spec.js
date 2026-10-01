import { test, expect } from '@playwright/test';

// FocusBro Pro, in a real browser: the /pro/ page and its first-party script,
// the "Save this mix" control on the sound card, and the website-only rule
// (Google Play) — inside the app no buy/upgrade control is ever visible.
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 FocusBroApp/0.1';

test.describe('FocusBro Pro — web', () => {
  test('/pro/ offers Pro once, and the button goes to checkout', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/pro/?fixture=buy');
    await expect(page.locator('h1')).toHaveText('FocusBro Pro');
    await expect(page.getByText('$9.99, once. No subscription')).toBeVisible();
    await page.locator('#proBuy').click();
    await expect(page).toHaveURL(/\/__smoke\/checkout$/);
    expect(errors).toEqual([]);
  });

  test('signed out: the guest door, not a new sign-up form', async ({ page }) => {
    await page.goto('/pro/?fixture=signed-out');
    await expect(page.locator('#proStart')).toBeVisible();
    await expect(page.locator('#proBuy')).toHaveCount(0);
  });

  test('the sound card shows "Save this mix" with a Pro badge that opens /pro/', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const btn = page.locator('#saveMixBtn');
    await expect(btn).toBeAttached();
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();
    await expect(page.locator('#saveMixBadge')).toBeVisible();
    await btn.click();
    await expect(page).toHaveURL(/\/pro\/$/);
  });

  test('a Pro person saves a named mix and it comes back in the list', async ({ page, context }) => {
    await context.addCookies([{ name: 'smoke_pro', value: '1', url: 'http://localhost:4173' }]);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#saveMixBadge')).toBeHidden();
    await page.locator('.sound-btn[data-sound="rain"]').click();
    await page.locator('#saveMixBtn').click();
    await page.locator('#saveMixName').fill('Morning rain');
    await page.locator('#saveMixForm button[type="submit"]').click();
    await expect(page.locator('#savedMixList')).toContainText('Morning rain');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fb_saved_mixes')));
    expect(stored[0]).toMatchObject({ name: 'Morning rain', mix: { rain: 1 } });
  });
});

test.describe('FocusBro Pro — inside the native app (Google Play: website-only purchase)', () => {
  test.use({ userAgent: APP_UA });

  test('/pro/ shows status only — no price, no buy button', async ({ page }) => {
    await page.goto('/pro/?fixture=buy');
    await expect(page.getByText('Pro isn’t active on this account.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('$');
    await expect(page.locator('#proBuy')).toHaveCount(0);
  });

  test('the sound card hides the Pro upsell when the app marks the page', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-native-app', 'android'));
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#saveMixBtn')).toBeAttached();
    await expect(page.locator('#saveMixBtn')).toBeHidden();
  });

  test('the weekly report preview link is hidden too', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-native-app', 'android'));
    });
    await page.goto('/me/report');
    await expect(page.locator('a.pro-buy')).toBeAttached();
    await expect(page.locator('a.pro-buy')).toBeHidden();
  });
});
