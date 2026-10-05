/**
 * FBQ-21 R1 + R2 (focusbro#391).
 *   R2 — the native app (UA token `FocusBroApp/`) gets `<html data-native-app>`
 *        stamped by the SERVER, and every Pro-framing element hangs off a class
 *        the stylesheet hides under that attribute: no "Pro" word, no price, on
 *        first paint, with no script needed. The web is unchanged.
 *   R1 — the privacy policy says what a coach can actually read, that a coach's
 *        voice and opening line shape messages, and how phone numbers are verified.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { makeMigratedD1, makeKV, DatabaseSync } from './helpers/real-d1.js';
import { privacySections, privacyPolicyBody } from '../privacy.js';
import { assertDesignLawClean } from '../design-law.js';
import servedHtml from '../html.js';

const suite = DatabaseSync ? describe : describe.skip;
const ORIGIN = 'https://focusbro.net';
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 FocusBroApp/0.1';
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const env = () => ({ DB: makeMigratedD1(), KV_CACHE: makeKV(), JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789', BUILD_SHA: 'abc1234' });
const get = (e, path, ua) => worker.fetch(new Request(ORIGIN + path, { headers: { 'User-Agent': ua } }), e, ctx);

suite('FBQ-21 R2 — no Pro framing in the native app, on first paint', () => {
  for (const path of ['/', '/me/', '/me/report', '/coach/']) {
    it(`${path}: an app-UA response carries data-native-app; a web response does not`, async () => {
      const e = env();
      const app = await get(e, path, APP_UA);
      expect(app.status).toBe(200);
      expect(await app.text()).toMatch(/<html[^>]*data-native-app="app"/);
      expect(app.headers.get('Vary') || '').toMatch(/User-Agent/i);
      const web = await get(e, path, WEB_UA);
      expect(await web.text()).not.toContain('data-native-app="app"');
    });
  }

  it('the /me/ and report shells hide every Pro framing element under the attribute', async () => {
    const e = env();
    const me = await (await get(e, '/me/', APP_UA)).text();
    expect(me).toContain('html[data-native-app] .pro-framing{display:none !important}');
    expect(me).toMatch(/class="pro-framing"[^>]*>\s*<span aria-hidden="true">·<\/span>\s*<a href="\/pro\/">Pro<\/a>/); // nav link
    expect(me).toMatch(/class="muted hidden pro-framing" id="channelPro"/);
    expect(me).toMatch(/class="muted hidden pro-framing" id="ceilingPro"/);
    const report = await (await get(e, '/me/report', APP_UA)).text();
    expect(report).toMatch(/id="pro-preview" class="card hidden pro-framing"/);
    expect(report).toContain('html[data-native-app] .pro-framing{display:none !important}');
  });

  it('the home shell hides the Pro command and the in-modal payments text in the app', async () => {
    const home = await (await get(env(), '/', APP_UA)).text();
    expect(home).toContain('html[data-native-app] .pro-buy,html[data-native-app] .pro-framing{display:none !important}');
    expect(home).toMatch(/<h3 class="pro-framing"[^>]*>Payments<\/h3>\s*<p class="pro-framing">/);
    expect(home).toMatch(/!document\.documentElement\.hasAttribute\('data-native-app'\)/);
  });

  it('the "(Pro)" option labels are suppressed for the app', async () => {
    const me = await (await get(env(), '/me/', APP_UA)).text();
    expect(me).toContain("!data.pro && !NATIVE && o.value !== 'none' ? ' (Pro)'");
    expect(me).toContain("!data.pro && !NATIVE && co.value === 'text' ? ' (Pro)'");
  });
});

suite('FBQ-21 R1 — the privacy policy says what a coach sees', () => {
  const coaches = () => privacySections().find(([h]) => h === 'Coaches')[1];
  const phone = () => privacySections().find(([h]) => h === 'Phone number and text messages')[1];

  it('names word titles, schedules, time zone, counts, cues, and the coach voice and opening line', () => {
    const t = coaches();
    for (const fact of ['by title', 'take my meds', 'how often each repeats', 'time zone', 'snoozed', 'gentle cue',
      'note sharing', 'voice and the opening line']) expect(t, fact).toContain(fact);
    expect(t).not.toContain('(counts and dates).');
  });

  it('says how phone numbers are verified', () => {
    expect(phone()).toContain('one-time code');
    expect(phone()).toContain('belongs to one account');
  });

  it('every surface carries it: the page body, public/privacy.html, and the in-app modal', async () => {
    expect(privacyPolicyBody()).toContain('take my meds');
    const res = await get(env(), '/privacy.html', WEB_UA);
    expect(await res.text()).toContain('voice and the opening line');
    expect(servedHtml).toContain('voice and the opening line');
    expect(servedHtml).toContain('one-time code to the number');
  });

  it('passes the design-law scan', () => {
    expect(() => assertDesignLawClean(privacyPolicyBody())).not.toThrow();
  });
});
