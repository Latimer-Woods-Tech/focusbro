// Promise-first home (flag homePromiseFirst, off by default; ?home=promise
// previews it). The default contract — hero AND toolkit on `/` — is pinned in
// smoke.spec.js; this is the other side: under the flag, home is the promise
// and your words, and the toolkit is exactly one tap away.
import { test, expect } from '@playwright/test';

test.describe('promise-first home', () => {
  test('default: the toolkit is still on the home page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#quickWordForm')).toBeVisible();
    await expect(page.locator('#pomoCard')).toBeVisible();
    await expect(page.locator('#homePromise')).toBeHidden();
  });

  test('?home=promise: the promise, your words, and one tap into the toolkit', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('/?home=promise', { waitUntil: 'domcontentloaded' });

    // the promise leads, and the block is the only thing in the main column
    await expect(page.locator('#quickWordForm')).toBeVisible();
    await expect(page.locator('#homePromise')).toBeVisible();
    await expect(page.locator('#homePromise')).toContainText('Give your word above and it shows up here.');
    await expect(page.locator('#pomoCard')).toBeHidden();
    await expect(page.locator('#keepAwakeCard')).toBeHidden();
    await expect(page.locator('.intention-banner')).toBeHidden();

    // one tap: the focus block is right there
    await page.locator('#homePromise').getByRole('button', { name: /Start a focus block/ }).click();
    await expect(page.locator('#pomoCard')).toBeVisible();
    await expect(page.locator('#homePromise')).toBeHidden();

    // and Home brings the promise back
    await page.locator('#navHome').click();
    await expect(page.locator('#homePromise')).toBeVisible();
    await expect(page.locator('#pomoCard')).toBeHidden();

    // the offer beacon carries the variant
    const offered = page.waitForRequest((r) => r.url().endsWith('/api/acquisition/word-offered'));
    await page.locator('#quickWordTask').fill('open the tax document');
    await page.locator('#quickWordForm').getByRole('button').click();
    expect((await offered).postDataJSON().home).toBe('promise');

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('?home=toolkit forces the toolkit even when the server stamped the promise', async ({ page }) => {
    // the harness serves the shell verbatim; the client override alone must hold
    await page.goto('/?home=toolkit', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#pomoCard')).toBeVisible();
    await expect(page.locator('#homePromise')).toBeHidden();
  });
});
