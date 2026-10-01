/**
 * FocusBro shows no ads (AdSense retired 2026-10-01, Factory#4641).
 *
 * AdSense rejected focusbro.net twice for "Low value content" and, at the
 * site's traffic, approval would have earned cents. Revenue moved to a
 * one-time Pro unlock. What must not drift back: an ad loader, an ad host in
 * the CSP, an /ads.txt claiming a publisher, or copy telling visitors we run
 * ads or ad cookies when we do not (the 2026-07 banner claimed AdSense on a
 * page with no ad code — say what the code does, nothing more).
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';
import { guides, renderGuidePage } from '../guides/index.js';
import worker from '../index.js';

const AD_MARKERS = /adsbygoogle|googlesyndication|ca-pub-\d+|doubleclick/i;

const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = { JWT_SECRET: 'test-secret', BUILD_SHA: 'test', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };

async function get(path) {
  return worker.fetch(new Request(`https://focusbro.net${path}`), env, { waitUntil() {} });
}

describe('no ads', () => {
  it('the app shell carries no ad loader and no AdSense copy', () => {
    expect(servedHtml).not.toMatch(AD_MARKERS);
    expect(servedHtml).not.toMatch(/AdSense/i);
    expect(servedHtml).not.toContain('cookieConsent');
  });

  it('no guide page carries an ad loader', () => {
    for (const g of guides) {
      expect(renderGuidePage(g), g.slug).not.toMatch(AD_MARKERS);
    }
  });

  it('/ads.txt no longer claims a publisher', async () => {
    const r = await get('/ads.txt');
    expect(await r.text()).not.toMatch(/pub-\d+/);
  });

  it('the CSP allowlists no ad host on any surface', async () => {
    for (const path of ['/', '/guides/box-breathing.html', '/privacy.html']) {
      const r = await get(path);
      const csp = r.headers.get('Content-Security-Policy') || r.headers.get('Content-Security-Policy-Report-Only');
      expect(csp, path).toBeTruthy();
      expect(csp, path).not.toMatch(AD_MARKERS);
    }
  });

  it('the privacy policy says there are no ads or ad cookies', async () => {
    const html = await (await get('/privacy.html')).text();
    expect(html).not.toMatch(/AdSense|DoubleClick|adssettings/i);
    expect(html).toMatch(/no ads/i);
  });
});
