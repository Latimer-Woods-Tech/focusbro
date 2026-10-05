/**
 * The way in and out must be findable (founder could not find sign in / out).
 *
 * - The home shell carries a plain account link to /me/ in the header, labelled
 *   "Sign in" until a session token exists, then "Your word".
 * - /me/ puts "Sign out" at the top of the signed-in view, not at the bottom
 *   below every card.
 * - Copy obeys the design law (no "AI", no shame words).
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { SHAME_PATTERNS } from '../design-law.js';

async function page(path) {
  const r = await worker.fetch(new Request('https://focusbro.net' + path),
    { KV_CACHE: { get: async () => null, put: async () => {} } }, { waitUntil() {} });
  expect(r.status).toBe(200);
  return r.text();
}

describe('home header account link', () => {
  it('has a visible /me/ link inside the header, defaulting to "Sign in"', async () => {
    const html = await page('/');
    const header = html.slice(html.indexOf('<header class="header">'), html.indexOf('</header>'));
    expect(header).toMatch(/<a [^>]*id="accountLink"[^>]*>Sign in<\/a>/);
    expect(header).toMatch(/<a [^>]*href="\/me\/"[^>]*>/);
  });

  it('switches to "Your word" on the cookie-session probe, never by reading a token', async () => {
    const html = await page('/');
    expect(html).toContain("if (fbAuthenticated) { var acct = document.getElementById('accountLink'); if (acct) acct.textContent = 'Your word'; }");
    expect(html).not.toContain("localStorage.getItem('focusbro_token')");
  });

  it('is quiet and law-abiding: no AI branding, no shame words', () => {
    for (const s of ['Sign in', 'Your word']) {
      expect(s).not.toMatch(/\bAI\b/);
      for (const re of SHAME_PATTERNS) expect(s).not.toMatch(re);
    }
  });
});

describe('/me/ sign out placement', () => {
  it('puts the sign-out link before the first card of the signed-in view', async () => {
    const html = await page('/me/');
    const app = html.indexOf('<div id="app"');
    const signout = html.indexOf('id="signout"');
    const firstCard = html.indexOf('id="firstRun"', app);
    expect(signout).toBeGreaterThan(app);
    expect(signout).toBeLessThan(firstCard);
    expect(html.match(/id="signout"/g)).toHaveLength(1);
  });
});
