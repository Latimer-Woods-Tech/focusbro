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

  test('carries a founder challenge straight into a first word — no password before the word', async ({ page }) => {
    // The door, after 2026-09-04: a visitor arriving with a task sees the form,
    // prefilled. Giving the word creates a guest account on THAT gesture, the
    // word is saved against it, push is asked for on the same gesture, and the
    // claim card appears. No email, no password, until the person wants them.
    const commitmentBodies = [];
    const guestStarts = [];
    const syncEvents = [];
    await page.route('**/auth/guest', async (route) => {
      guestStarts.push(route.request().method());
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, user_id: 'g1', guest: true, session_id: 's1' }) });
    });
    await page.route('**/auth/session', async (route) => {
      await route.fulfill({ status: guestStarts.length ? 200 : 401, contentType: 'application/json', body: JSON.stringify(guestStarts.length ? { authenticated: true, user_id: 'g1', guest: true, email: null } : { authenticated: false }) });
    });
    await page.route('**/sync/events', async (route) => {
      syncEvents.push(...(route.request().postDataJSON().events || []));
      await route.fulfill({ contentType: 'application/json', body: '{"success":true,"synced":1}' });
    });
    await page.route('**/vapid/public-key', async (route) => { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Push notifications not configured"}' }); });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/commitments' && request.method() === 'POST') {
        commitmentBodies.push({ body: request.postDataJSON(), afterGuest: guestStarts.length > 0 });
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ message: "Got it — I'll check in." }) });
        return;
      }
      if (path === '/api/commitments') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commitments: [] }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });

    await page.goto('/me/?task=open%20the%20tax%20document&when=in%2010%20minutes&source=tiktok&campaign=founder-cohort-01');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#signin')).toBeHidden();                 // no password wall
    await expect(page.locator('#anonNote')).toBeVisible();
    await expect(page.locator('#claimCard')).toBeHidden();               // nothing to claim yet
    await expect(page.locator('#title')).toHaveValue('open the tax document');
    await expect(page.locator('#startAt')).toHaveValue('in 10 minutes');
    expect(guestStarts).toEqual([]);                                     // never on load
    await page.locator('#commitForm').getByRole('button', { name: 'Give my word' }).click();
    await expect(page.locator('#commitMsg')).toContainText("Got it — I'll check in.");
    expect(guestStarts).toEqual(['POST']);                               // exactly once, on the gesture
    expect(commitmentBodies).toEqual([{ afterGuest: true, body: expect.objectContaining({
      title: 'open the tax document',
      when_text: 'in 10 minutes',
      channel: 'push',
      attribution: { source: 'tiktok', campaign: 'founder-cohort-01' },
    }) }]);
    // the guest is offered the account, and the sign-in link is gone
    await expect(page.locator('#claimCard')).toBeVisible();
    await expect(page.locator('#anonNote')).toBeHidden();
    // push was asked for on the same gesture and the browser's answer recorded
    await expect.poll(() => syncEvents.filter((e) => e.type === 'push_permission').length, { timeout: 5000 }).toBe(1);
    expect(['unsupported', 'denied', 'dismissed', 'not_configured', 'failed', 'granted']).toContain(syncEvents.find((e) => e.type === 'push_permission').result);
    // a returning person can still reach sign-in in one tap
    await page.reload();
    await expect(page.locator('#claimCard')).toBeVisible();              // the session says guest
  });

  test('turns an honest “not yet” into a warm reschedule instead of a dead end', async ({ page }) => {
    const checkinBodies = [];
    await page.route('**/auth/session', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/commitments' && request.method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commitments: [{
          id: 'commitment-1', title: 'open the tax document', status: 'active',
          start_at: '2026-07-26T18:00:00.000Z', checkin_at: '2026-07-26T18:00:00.000Z', recurrence: 'none',
        }] }) });
        return;
      }
      if (path === '/api/commitments/commitment-1/checkin') {
        checkinBodies.push(request.postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: 'No problem — moved it.' }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    page.on('dialog', (dialog) => dialog.accept('after dinner'));

    await page.goto('/me/');
    await expect(page.locator('#app')).toBeVisible();
    await page.getByRole('button', { name: 'Not yet' }).click();
    await expect(page.locator('[data-msg="commitment-1"]')).toContainText('No problem — moved it.');
    expect(checkinBodies).toEqual([{ outcome: 'reschedule', when_text: 'after dinner' }]);
  });

  test('the soundscape follows the focus block — fades at the bell, returns on the next one', async ({ page }) => {
    // The ritual, end to end, in a real browser: choose a blend, start a focus
    // block, ring the bell, start the break, ring it again, start the next
    // block. The sound must stop at the bell, stay stopped through the break,
    // and come back — the same blend — when focus resumes. Nothing autoplays.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Enter the way a guide reader does: the sounds deep-link lands ON the card.
    await page.goto('/?tool=sounds', { waitUntil: 'domcontentloaded' });
    // The consent banner owns the bottom of a phone viewport; a person taps it
    // away first. Then let the card's ring animation settle before tapping.
    const consent = page.getByRole('button', { name: 'Got it' });
    if (await consent.isVisible().catch(() => false)) await consent.click();
    await expect(page.locator('.card.deeplink-flash')).toHaveCount(0, { timeout: 3000 });

    const playing = page.locator('#soundNowPlaying');
    const deepWork = page.getByRole('button', { name: 'Play the Deep work blend' });
    const start = page.locator('#pomoStartBtn');
    const active = () => page.evaluate(() => Object.keys(activeSounds).sort());
    // A fixed header sits over the top of a phone viewport, so centre a target
    // before tapping it — the same thing a thumb does. No force-clicks: those
    // would hide a real overlap bug instead of surfacing it.
    const tap = async (locator) => {
      // Instant, not smooth: a smooth scroll keeps moving after Playwright's
      // stability check, so the click lands on whatever slides under the
      // target. Then wait until the box holds still across two frames.
      await locator.evaluate(async (el) => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        let prev = null;
        for (let i = 0; i < 20; i++) {
          await frame();
          const b = el.getBoundingClientRect();
          const key = `${Math.round(b.top)}:${Math.round(b.left)}`;
          if (key === prev) return;
          prev = key;
        }
      });
      await locator.click();
    };

    // 1. choose a blend (a real tap — the gesture the audio policy needs)
    await tap(deepWork);
    await expect(deepWork).toHaveAttribute('aria-pressed', 'true');
    await expect(playing).toContainText('Playing:');
    expect(await active()).toEqual(['brown', 'wind']);
    expect(await page.evaluate(() => getAudioCtx().state)).toBe('running');

    // 2. focus block → the bell (skipPomodoro forces it; no 25-minute wait).
    //    The timer lives in the home/focus views, not the Restore view the
    //    sounds link landed on — go home the way the nav does.
    await page.evaluate(() => setView('home'));
    await expect(start).toBeVisible();
    await tap(start);
    await expect(page.locator('body')).toHaveClass(/session-active/);
    await page.evaluate(() => skipPomodoro());
    await expect(page.locator('body')).not.toHaveClass(/session-active/, { timeout: 5000 });
    await expect(playing).toHaveText('Nothing playing', { timeout: 5000 });
    await expect(deepWork).toHaveAttribute('aria-pressed', 'false');
    expect(await active()).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('fb_sound_follow'))).toBe('1');

    // 3. the break starts — a break must NEVER start a sound
    await tap(start);
    await expect(page.locator('body')).toHaveClass(/session-active/);
    expect(await active()).toEqual([]);
    await page.evaluate(() => skipPomodoro());
    await expect(page.locator('body')).not.toHaveClass(/session-active/, { timeout: 5000 });
    expect(await active()).toEqual([]);

    // 4. the next focus block — the same blend comes back on its own
    expect(await page.evaluate(() => pomoState.phase)).toBe('work');
    await tap(start);
    await expect(playing).toContainText('Playing:', { timeout: 5000 });
    expect(await active()).toEqual(['brown', 'wind']);
    await expect(deepWork).toHaveAttribute('aria-pressed', 'true');

    // 5. an explicit Stop all ends the ritual: the next bell has nothing to
    //    remember, and the next block starts silent
    await tap(page.getByRole('button', { name: 'Stop all' }));
    await expect(playing).toHaveText('Nothing playing');
    expect(await page.evaluate(() => localStorage.getItem('fb_sound_follow'))).toBeNull();
    await page.evaluate(() => skipPomodoro());
    await expect(page.locator('body')).not.toHaveClass(/session-active/, { timeout: 5000 });
    await tap(start); // break
    await page.evaluate(() => skipPomodoro());
    await expect(page.locator('body')).not.toHaveClass(/session-active/, { timeout: 5000 });
    await tap(start); // focus — must stay silent
    await page.waitForTimeout(600);
    expect(await active()).toEqual([]);

    expect(pageErrors).toEqual([]);
  });

  test('a sound deep-link arms one tap and never autoplays', async ({ page }) => {
    await page.goto('/?tool=sounds&preset=winddown', { waitUntil: 'domcontentloaded' });
    const armed = page.locator('#soundResume');
    await expect(armed).toBeVisible();
    await expect(armed).toHaveText('▶ Start Wind down');
    await expect(armed).toHaveClass(/armed/);
    // the URL params are cleared so a refresh cannot re-trigger
    expect(new URL(page.url()).search).toBe('');
    // nothing is playing until the tap
    expect(await page.evaluate(() => Object.keys(activeSounds))).toEqual([]);
    await armed.click();
    await expect(armed).toBeHidden();
    expect(await page.evaluate(() => Object.keys(activeSounds).sort())).toEqual(['drone', 'ocean']);
    await expect(page.getByRole('button', { name: 'Play the Wind down blend' })).toHaveAttribute('aria-pressed', 'true');

    // a named sound list works the same way, validated against the palette
    await page.goto('/?sound=rain,cafe,notasound', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#soundResume')).toHaveText('▶ Start Rain + Café');
    await page.locator('#soundResume').click();
    expect(await page.evaluate(() => Object.keys(activeSounds).sort())).toEqual(['cafe', 'rain']);
  });

  test('a mix can be shared as a link that arms the same layers at the same levels', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?tool=sounds', { waitUntil: 'domcontentloaded' });
    const share = page.locator('#soundShare');
    await expect(share).toBeDisabled();                       // nothing playing, nothing to share
    await page.getByRole('button', { name: 'Play the Rainy café blend' }).click();
    await expect(share).toBeEnabled();
    await share.click();
    await expect(page.locator('#soundNowPlaying')).toContainText('Link copied: Rain + Café');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://focusbro.net/?tool=sounds&preset=rainycafe');
    // add a layer — it is the person's own mix now, shared with its levels
    await page.locator('.sound-btn[data-sound="wind"]').click();
    await share.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://focusbro.net/?tool=sounds&sound=cafe:0.5,rain:0.7,wind');
    // that link arms exactly those layers at those levels — one tap, never autoplay
    await page.goto('/?tool=sounds&sound=cafe:0.5,rain:0.7,wind', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#soundResume')).toHaveText('▶ Start Café + Rain + Wind');
    expect(await page.evaluate(() => Object.keys(activeSounds))).toEqual([]);
    await page.locator('#soundResume').click();
    expect(await page.evaluate(() => Object.keys(activeSounds).sort().map((n) => [n, activeSounds[n].mix]))).toEqual([['cafe', 0.5], ['rain', 0.7], ['wind', 1]]);
    await expect(share).toBeEnabled();
  });

  test('the caffeine calculator computes the cited arithmetic in a real browser', async ({ page }) => {
    // 200 mg at 15:00, bedtime 23:00, half-life 5 h → 200 · 0.5^(8/5) ≈ 66 mg.
    // Deterministic: every input is set explicitly, so "now" never leaks in.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('/guides/caffeine-timing-and-focus.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#caffeine-calculator')).toBeVisible();
    await page.locator('#cafDose').fill('200');
    await page.locator('#cafTaken').fill('15:00');
    await page.locator('#cafBed').fill('23:00');
    await page.locator('#cafHalf').fill('5');
    await page.locator('#caffeineCalc button[type="submit"]').click();
    await expect(page.locator('#cafResult')).toContainText('about 66 mg of the 200 mg');
    await expect(page.locator('#cafResult')).toContainText('(33%)');
    // half gone by 20:00, a quarter left by 01:00
    await expect(page.locator('#cafResult')).toContainText('Half of it is gone by 20:00');
    await expect(page.locator('#cafResult')).toContainText('a quarter is left by 01:00');
    // the curve was drawn, with bedtime marked
    expect(await page.locator('#cafChart path.tool-curve').count()).toBe(1);
    expect(await page.locator('#cafChart circle.tool-beddot').count()).toBe(1);
    // and using the instrument was recorded, once, anonymously. sendBeacon()
    // is invisible to Playwright's request hooks, so ask the smoke server what
    // it actually received.
    await expect.poll(async () => {
      const views = await (await page.request.get('/__smoke/views')).json();
      return views.filter((v) => v.tool === 'caffeine-calculator');
    }, { timeout: 5000 }).toEqual([{ slug: 'caffeine-timing-and-focus', tool: 'caffeine-calculator' }]);
    // a preset fills the dose from the FDA figure
    await page.locator('#cafPreset').selectOption('71');
    await expect(page.locator('#cafDose')).toHaveValue('71');
    await expect(page.locator('#cafResult')).toContainText('of the 71 mg');
    expect(pageErrors).toEqual([]);
  });

  test('the breathing pacer counts the guide\u2019s own pattern, phase by phase, in a real browser', async ({ page }) => {
    // 4-7-8: in 4, hold 7, out 8 — three phases, 19 s, capped at four rounds.
    // The clock is faked so a full round takes no wall time and the count
    // shown at each instant is deterministic; rAF and performance.now() are
    // both under the fake, which is exactly what the pacer follows.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.clock.install({ time: new Date('2026-09-04T09:00:00') });
    await page.goto('/guides/4-7-8-breathing.html', { waitUntil: 'domcontentloaded' });
    await page.clock.pauseAt(new Date('2026-09-04T09:00:01'));
    await expect(page.locator('#breathing-pacer')).toBeVisible();
    // the rounds select stops where the guide does: four
    expect(await page.locator('#pacerRounds option').count()).toBe(4);
    await expect(page.locator('#pacerRounds')).toHaveValue('4');
    await page.locator('#pacerRounds').selectOption('1');
    // the swell is opted into with a gesture; it must never be on by default
    await expect(page.locator('#pacerSound')).not.toBeChecked();
    await page.locator('#pacerSound').check();
    await page.locator('#pacerStart').click();
    await page.clock.runFor(50);
    await expect(page.locator('#pacerPhase')).toHaveText('Inhale');
    await expect(page.locator('#pacerCount')).toHaveText('4');
    await expect(page.locator('#pacerRound')).toHaveText('Round 1 of 1');
    await expect(page.locator('#pacerStop')).toBeVisible();
    await expect(page.locator('#pacerStart')).toBeHidden();
    await page.clock.runFor(4000);
    await expect(page.locator('#pacerPhase')).toHaveText('Hold');
    await expect(page.locator('#pacerCount')).toHaveText('7');
    await page.clock.runFor(7000);
    await expect(page.locator('#pacerPhase')).toHaveText('Exhale');
    await expect(page.locator('#pacerCount')).toHaveText('8');
    await page.clock.runFor(7900);
    await expect(page.locator('#pacerCount')).toHaveText('1');
    await page.clock.runFor(200);
    await expect(page.locator('#pacerPhase')).toHaveText('Done');
    await expect(page.locator('#pacerRound')).toContainText('1 round');
    await expect(page.locator('#pacerStart')).toBeVisible();
    await expect(page.locator('#pacerStop')).toBeHidden();
    // switching pattern re-caps the rounds and swaps the note; the shorter
    // form is still four rounds at most
    await page.locator('#pacerPattern').selectOption('478short');
    expect(await page.locator('#pacerRounds option').count()).toBe(4);
    await expect(page.locator('#pacerNote')).toContainText('Keep the ratio');
    // starting it was recorded once, anonymously — ask the server, since
    // sendBeacon() is invisible to Playwright's request hooks
    await expect.poll(async () => {
      const views = await (await page.request.get('/__smoke/views')).json();
      return views.filter((v) => v.tool === 'breathing-pacer');
    }, { timeout: 5000 }).toEqual([{ slug: '4-7-8-breathing', tool: 'breathing-pacer' }]);
    expect(pageErrors).toEqual([]);
  });

  test('the Follow-Through Index page states its floors and never prints a rate it has not earned', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('/follow-through-index.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('The Follow-Through Index');
    await expect(page.locator('#current-figures')).toContainText('unavailable');
    expect(await page.locator('#current-figures').textContent()).not.toMatch(/\d+%/);
    // the published state, from the same renderer with known figures
    await page.goto('/follow-through-index.html?fixture=published', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#current-figures')).toContainText('Kept-word rate');
    await expect(page.locator('#current-figures')).toContainText('64%');
    await expect(page.locator('#current-figures')).toContainText('Generated:');
    // script-free by design: nothing to execute, nothing to break
    expect(await page.locator('script:not([type="application/ld+json"])').count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('the app’s breathing modal paces a box round the way the guide says, in a real browser', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-04T09:00:00') });
    await page.goto('/?tool=breathing', { waitUntil: 'domcontentloaded' });
    await page.clock.pauseAt(new Date('2026-09-04T09:00:01'));
    await expect(page.locator('#breathingModal')).toHaveClass(/show/);
    await expect(page.locator('#breathingLabel')).toHaveText('Inhale (4s)');
    await page.clock.runFor(3000);
    await expect(page.locator('#breathingLabel')).toHaveText('Inhale (1s)');
    await page.clock.runFor(1000);
    await expect(page.locator('#breathingLabel')).toHaveText('Hold (4s)');    // four ticks, not five
    await page.clock.runFor(4000);
    await expect(page.locator('#breathingLabel')).toHaveText('Exhale (4s)');
    expect(await page.locator('#breathingCircle').evaluate((el) => el.style.animation)).toContain('breathe-out');
  });

  test('renders a stored meeting name as text, never markup', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('focusbro_cookie_consent_v1', 'accepted'));
    await page.goto('/');
    await page.locator('#meetingName').fill('<img src=x onerror="window.meetingXss=true">Study');
    await page.locator('#meetingTime').fill('23:59');
    await page.locator('button[onclick="setMeeting()"]').evaluate((button) => button.click());

    await expect(page.locator('#meetingDisplay .meeting-name')).toHaveText('<img src=x onerror="window.meetingXss=true">Study');
    await expect(page.locator('#meetingDisplay img')).toHaveCount(0);
    expect(await page.evaluate(() => window.meetingXss)).toBeUndefined();
  });
});
