import { test, expect } from '@playwright/test';

// Smoke of the client app served from the built html.js. Asserts the load-bearing
// UX contracts that unit tests can't see, including the timer-first regression
// guard (the onboarding modal must NOT auto-cover the timer).
test.describe('FocusBro client smoke', () => {
  test('loads, leads with accountability, and preserves the toolkit', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Renders
    await expect(page).toHaveTitle(/FocusBro/);
    await expect(page.locator('#quickWordForm')).toBeVisible();

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

    // The acquisition form carries the promise, timing, and campaign context
    // through the sign-in gate instead of dropping the visitor onto a blank form.
    await page.locator('#quickWordTask').fill('open the tax document');
    await page.locator('#quickWordWhen').selectOption('in 10 minutes');
    await page.locator('#quickWordForm').evaluate((form) => {
      form.ownerDocument.defaultView.history.replaceState(
        null, '', '/?utm_source=tiktok&utm_campaign=founder-story-01',
      );
    });
    await page.locator('#quickWordForm').getByRole('button').click();
    await expect(page).toHaveURL(/\/me\/\?/);
    expect(new URL(page.url()).searchParams.get('task')).toBe('open the tax document');
    expect(new URL(page.url()).searchParams.get('source')).toBe('tiktok');
    expect(new URL(page.url()).searchParams.get('campaign')).toBe('founder-story-01');

    // No uncaught client exceptions during the smoke.
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
