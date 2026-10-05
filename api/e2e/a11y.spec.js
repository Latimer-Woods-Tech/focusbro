import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

// FBQ-22: keyboard and screen-reader users can operate the app. Each check
// here failed on main before the fix (axe, focus ring, dialogs, landmarks,
// reduced motion, tap targets, 320px overflow).
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const PAGES = ['/', '/guides/the-body-scan.html', '/follow-through-index.html'];

async function axe(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) })));
}

test.describe('FBQ-22 accessibility', () => {
  const AXE_RUNS = [...PAGES, '/me/', '/me/report', '/pro/?fixture=signed-out'].map((p) => [p, 'light'])
    .concat([['/', 'dark'], ['/me/', 'dark']]);
  for (const [path, scheme] of AXE_RUNS) {
    test(`axe: no serious or critical violations, one main landmark — ${path} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      const violations = await axe(page);
      expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
      expect(violations.filter((v) => v.id === 'landmark-one-main' || v.id === 'region')).toEqual([]);
    });
  }

  for (const path of PAGES) {

    test(`no horizontal overflow at 320px — ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(wide).toBeLessThanOrEqual(320);
    });
  }

  test('no horizontal overflow at 320px — /guides/meditation-and-attention.html', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/guides/meditation-and-attention.html', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test('the skip link lands on the main landmark', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const target = await page.locator('.skip-link').getAttribute('href');
    expect(await page.locator(target).evaluate((el) => el.tagName)).toBe('MAIN');
  });

  // Read the instant focus lands: a `transition: all` used to animate the ring
  // in from 0px, and some inputs swapped it for a 10%-alpha shadow.
  for (const viewport of [{ width: 1280, height: 800 }, null]) {
    test(`:focus-visible draws a token-coloured ring at once (${viewport ? 'desktop' : 'phone'})`, async ({ page }) => {
      if (viewport) await page.setViewportSize(viewport);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      for (const sel of ['#navHome', '#navRest', '#navStats', '#zenBtn', '#taskInput', '#quickWordTask', '.sound-btn']) {
        const ring = await page.locator(sel).first().evaluate((el) => {
          const probe = document.createElement('i');
          probe.style.color = 'var(--primary)';
          document.body.appendChild(probe);
          const token = getComputedStyle(probe).color;
          probe.remove();
          el.focus();
          const cs = getComputedStyle(el);
          return { visible: el.matches(':focus-visible'), width: parseFloat(cs.outlineWidth) || 0,
            style: cs.outlineStyle, color: cs.outlineColor, token };
        });
        expect(ring.visible, sel).toBe(true);
        expect(ring.width >= 2 && ring.style !== 'none' && ring.color === ring.token, `${sel} ${JSON.stringify(ring)}`).toBe(true);
      }
    });
  }

  test('reduced motion stops the time bar and the fidget spinner', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await page.locator('#timeBarFill').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(await page.locator('#fidgetSpinner').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('tap targets are at least 44px', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    for (const sel of ['#navHome', '#navFocus', '#navRest', '#navStats']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.height, sel).toBeGreaterThanOrEqual(44);
    }
    await page.goto('/pro/?fixture=signed-out', { waitUntil: 'domcontentloaded' });
    expect((await page.locator('#proStart').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.goto('/guides/the-body-scan.html', { waitUntil: 'domcontentloaded' });
    for (const a of await page.locator('header.site a, footer.site a').all()) {
      expect((await a.boundingBox()).height, await a.textContent()).toBeGreaterThanOrEqual(44);
    }
  });

  // Every tool modal opened from its own button: a dialog, focus inside, Tab
  // stays inside, Esc closes, and focus goes back to the button.
  const TRIGGERED = [
    ['breathingModal', 'button:has-text("Breathing Guide")'],
    ['groundingModal', 'button:has-text("5-4-3-2-1 Grounding")'],
    ['dopamineModal', 'button:has-text("Quick lifts") >> nth=0'],
    ['meditationModal', '.tool-tile:has-text("Meditate")'],
    ['movementModal', '.tool-tile:has-text("Movement")'],
    ['sleepModal', '.tool-tile:has-text("Sleep")'],
    ['bodyScanModal', '.tool-tile:has-text("Body Scan")'],
    ['socialModal', '.tool-tile:has-text("Focus Score")'],
  ];
  // Opened by the app itself (timer, palette), not by a button.
  const PROGRAMMATIC = ['breakModal', 'hyperfocusModal', 'onboardingModal'];

  async function walk(page, id, open) {
    const modal = page.locator(`#${id}`);
    await open();
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    const label = await modal.evaluate((el) => {
      const ref = el.getAttribute('aria-labelledby');
      return ref && document.getElementById(ref) ? document.getElementById(ref).textContent.trim() : '';
    });
    expect(label, `${id} label`).not.toBe('');
    const inside = () => modal.evaluate((el) => el.contains(document.activeElement));
    await expect.poll(inside, { message: `${id} focus moved in` }).toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `${id} Tab #${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await inside(), `${id} Shift+Tab`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  }

  for (const [id, trigger] of TRIGGERED) {
    test(`keyboard walk — ${id}`, async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const opener = page.locator(trigger);
      await walk(page, id, async () => { await opener.focus(); await page.keyboard.press('Enter'); });
      expect(await opener.evaluate((el) => el === document.activeElement), `${id} focus restored`).toBe(true);
    });
  }

  for (const id of PROGRAMMATIC) {
    test(`keyboard walk — ${id}`, async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.locator('#zenBtn').focus();
      await walk(page, id, () => page.evaluate((m) => document.getElementById(m).classList.add('show'), id));
      expect(await page.evaluate(() => document.activeElement.id)).toBe('zenBtn');
    });
  }
});
