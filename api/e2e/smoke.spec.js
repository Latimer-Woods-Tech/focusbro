import { test, expect } from '@playwright/test';

// Smoke of the client app served from the built html.js. Asserts the load-bearing
// UX contracts that unit tests can't see, including the timer-first regression
// guard (the onboarding modal must NOT auto-cover the timer).
test.describe('FocusBro client smoke', () => {
  test('loads, is timer-first, and the command palette works', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Renders
    await expect(page).toHaveTitle(/FocusBro/);

    // Timer-first: One Thing + Pomodoro are present, and the onboarding modal
    // does NOT auto-pop over them (regression guard for the timer-first change).
    await expect(page.locator('.intention-banner')).toBeVisible();
    await expect(page.locator('#pomoCard')).toBeVisible();
    await page.waitForTimeout(1200); // past the old 800ms auto-pop timer
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/\bshow\b/);

    // Command palette opens on Ctrl/Cmd+K and the opt-in tour entry is present
    await page.keyboard.press('Control+k');
    await expect(page.locator('#cmdPalette')).toHaveClass(/\bopen\b/);
    await expect(page.getByText('How FocusBro works')).toBeVisible();
    await page.keyboard.press('Escape');

    // No uncaught client exceptions during the smoke.
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
