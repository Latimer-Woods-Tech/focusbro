import { test, expect } from '@playwright/test';

// Smoke of the client app served from the built html.js. Asserts the load-bearing
// UX contracts that unit tests can't see, including the timer-first regression
// guard (the onboarding modal must NOT auto-cover the timer).
test.describe('FocusBro client smoke', () => {
  test('loads, leads with accountability, and preserves the toolkit', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const visitRequest = page.waitForRequest((request) =>
      request.url().endsWith('/api/acquisition/visit'));
    await page.goto('/?utm_source=tiktok&utm_campaign=landing-01&utm_content=demo-01',
      { waitUntil: 'domcontentloaded' });
    const visit = await visitRequest;
    expect(visit.method()).toBe('POST');
    expect(visit.postDataJSON()).toEqual({
      attribution: { source: 'tiktok', campaign: 'landing-01', content: 'demo-01' },
    });

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

  test('carries a founder challenge through account creation into a first word', async ({ page }) => {
    const commitmentBodies = [];
    await page.route('**/auth/register', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 'u1' } }) });
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/commitments' && request.method() === 'POST') {
        commitmentBodies.push(request.postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: "Got it — I'll check in." }) });
        return;
      }
      if (path === '/api/commitments') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commitments: [] }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });

    await page.goto('/me/?task=open%20the%20tax%20document&when=in%2010%20minutes&source=tiktok&campaign=founder-cohort-01');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    await page.locator('#email').fill('founder@example.com');
    await page.locator('#password').fill('safe-password-123');
    await page.locator('#signinForm').getByRole('button', { name: 'Create account' }).click();

    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#title')).toHaveValue('open the tax document');
    await expect(page.locator('#startAt')).toHaveValue('in 10 minutes');
    await page.locator('#commitForm').getByRole('button', { name: 'Give my word' }).click();
    await expect(page.locator('#commitMsg')).toContainText("Got it — I'll check in.");

    expect(commitmentBodies).toEqual([expect.objectContaining({
      title: 'open the tax document',
      when_text: 'in 10 minutes',
      attribution: { source: 'tiktok', campaign: 'founder-cohort-01' },
    })]);
  });
});
