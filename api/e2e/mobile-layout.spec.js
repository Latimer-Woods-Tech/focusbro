import { test, expect } from '@playwright/test';

// Phone layout contract. The dashboard grid used `1fr` (min-content floor) and the
// meeting/One-Thing inputs would not shrink, so on a 390px phone the page laid out
// at 465px: every card, the cookie banner and the bottom bar ran off the right edge.
// The bottom bar also showed seven unlabeled emoji. These assertions fail on that tree.
const WIDTHS = [320, 360, 390];
const VIEWS = ['home', 'focus', 'rest', 'stats'];

for (const width of WIDTHS) {
  test.describe(`phone ${width}px`, () => {
    test.use({ viewport: { width, height: 740 } });

    test('no view is wider than the screen', async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      for (const view of VIEWS) {
        await page.evaluate((v) => window.setView(v), view);
        await page.waitForTimeout(350);
        const { inner, scroll } = await page.evaluate(() => ({
          inner: window.innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(inner, `${view}: layout viewport widened`).toBe(width);
        expect(scroll, `${view}: horizontal scroll`).toBeLessThanOrEqual(width);
      }
    });

    test('bottom bar tabs are labeled and fit on screen', async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const tabs = page.locator('nav.app-nav .nav-item:visible');
      await expect(tabs).toHaveText([/Home/, /Focus/, /Restore/, /Stats/, /My word/, /More/]);
      const boxes = await tabs.evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        const label = e.querySelector('.nav-label');
        return { right: r.right, clipped: label.scrollWidth > label.clientWidth + 1 };
      }));
      for (const b of boxes) {
        expect(b.right).toBeLessThanOrEqual(width);
        expect(b.clipped, 'tab label truncated').toBe(false);
      }
    });
  });
}

test('theme stays reachable on phones through More', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#themeToggle')).toBeHidden();
  await page.locator('nav.app-nav .nav-item:visible').last().click();
  await expect(page.locator('#cmdPalette')).toHaveClass(/\bopen\b/);
  await expect(page.getByText('Light / dark theme')).toBeVisible();
});
