import { test, expect } from '@playwright/test';

// Account deletion in a real browser (Google Play User Data policy): the
// "Delete my account" card at the bottom of /me/, its typed confirm, the
// landing page — and that the card is NOT hidden inside the native app.
// The deletion itself is proven against a real schema in vitest
// (src/__tests__/account-delete.test.js); here the smoke server records the
// request the page sends.

async function signIn(context) {
  await context.addCookies([{ name: 'smoke_session', value: '1', url: 'http://localhost:4173' }]);
}

test.describe('Delete my account — /me/', () => {
  test('a signed-in person deletes their account with a typed confirm and lands on "Your account is gone"', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/me/');
    const card = page.locator('#deleteAccount');
    await expect(card).toBeVisible();
    await expect(card).toContainText('What we keep');
    await expect(page.locator('#deleteConfirmForm')).toBeHidden();

    await page.locator('#deleteStart').click();
    const confirm = page.locator('#deleteConfirm');
    await expect(confirm).toBeDisabled();
    await page.locator('#deleteConfirmInput').fill('delet');
    await expect(confirm).toBeDisabled();
    await page.locator('#deleteConfirmInput').fill('DELETE');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page).toHaveURL(/\/account\/deleted$/);
    await expect(page.locator('h1')).toHaveText('Your account is gone');
    const sent = await (await page.request.get('/__smoke/deletes')).json();
    expect(sent.at(-1)).toEqual({ body: { confirm: 'DELETE' }, contentType: 'application/json' });
  });

  test('"Keep my account" closes the confirm step and sends nothing', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/me/');
    const before = (await (await page.request.get('/__smoke/deletes')).json()).length;
    await page.locator('#deleteStart').click();
    await page.locator('#deleteConfirmInput').fill('DELETE');
    await page.locator('#deleteCancel').click();
    await expect(page.locator('#deleteConfirmForm')).toBeHidden();
    await expect(page.locator('#deleteStart')).toBeVisible();
    expect((await (await page.request.get('/__smoke/deletes')).json()).length).toBe(before);
  });

  test('signed out, there is no account to delete — the card stays hidden', async ({ page }) => {
    await page.goto('/me/');
    await expect(page.locator('#deleteAccount')).toBeAttached();
    await expect(page.locator('#deleteAccount')).toBeHidden();
  });

  test('inside the native app the card is still there (deletion is never hidden in-app)', async ({ page, context }) => {
    await signIn(context);
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-native-app', 'android'));
    });
    await page.goto('/me/');
    await expect(page.locator('#deleteAccount')).toBeVisible();
    await expect(page.locator('#deleteStart')).toBeVisible();
  });
});

test('the public deletion-request page explains the in-app steps and the email path', async ({ page }) => {
  await page.goto('/account/delete');
  await expect(page.locator('h1')).toHaveText('Delete your FocusBro account');
  await expect(page.locator('a[href="/me/#delete"]')).toBeVisible();
  await expect(page.locator('a[href^="mailto:support@focusbro.net"]')).toBeVisible();
});
