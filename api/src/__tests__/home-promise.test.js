/**
 * Promise-first home (council plan, move C) — behind a flag, off by default.
 *
 * The home page said one thing ("the check-in that follows up") and showed
 * twenty tools. Under the flag, home is the promise and your words; the
 * toolkit lives one tap away in the Focus / Restore views that already exist.
 *
 * Contract: with the flag off, `/` is byte-identical to today. The variant is
 * resolved on the server (config, or HOME_PROMISE_FIRST=1 at runtime) and
 * previewable per request with ?home=promise | ?home=toolkit, which the client
 * honors too (the e2e harness serves the shell verbatim).
 */

import { describe, it, expect } from 'vitest';
import worker, { homeVariantFor, shellHtml } from '../index.js';
import servedHtml from '../html.js';
import config from '../config.js';
import { isFeatureEnabled } from '../features.js';

const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const base = { JWT_SECRET: 'test-secret', BUILD_SHA: 'test', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };
const get = (path, env = base) => worker.fetch(new Request(`https://focusbro.net${path}`), env, { waitUntil() {} });

describe('the flag', () => {
  it('exists and is OFF — a founder flips it after seeing it on the Chromebook', () => {
    expect(config.features.homePromiseFirst).toMatchObject({ enabled: false });
    expect(isFeatureEnabled('homePromiseFirst')).toBe(false);
  });

  it('resolves: query override > runtime var > config', () => {
    expect(homeVariantFor({}, 'https://focusbro.net/')).toBe('toolkit');
    expect(homeVariantFor({ HOME_PROMISE_FIRST: '1' }, 'https://focusbro.net/')).toBe('promise');
    expect(homeVariantFor({ HOME_PROMISE_FIRST: '0' }, 'https://focusbro.net/')).toBe('toolkit');
    expect(homeVariantFor({}, 'https://focusbro.net/?home=promise')).toBe('promise');
    expect(homeVariantFor({ HOME_PROMISE_FIRST: '1' }, 'https://focusbro.net/?home=toolkit')).toBe('toolkit');
    expect(homeVariantFor({}, 'https://focusbro.net/?home=garbage')).toBe('toolkit');
    expect(homeVariantFor(undefined, 'not a url')).toBe('toolkit');
  });
});

describe('the served shell', () => {
  it('flag off: `/` is byte-identical to the built shell (nothing changes for anyone)', async () => {
    const html = await (await get('/')).text();
    expect(html).toBe(servedHtml);
    // the real tag sits alone at line start (the markup comment above the block also spells it out)
    expect(html).toMatch(/\n<body>\n/);
    expect(html).not.toMatch(/\n<body data-home=/);
    expect(shellHtml({}, 'https://focusbro.net/')).toBe(servedHtml);
  });

  it('flag on (runtime var) or ?home=promise: <body> is stamped, on / and /index.html', async () => {
    for (const [path, env] of [['/', { ...base, HOME_PROMISE_FIRST: '1' }], ['/?home=promise', base], ['/index.html?home=promise', base]]) {
      const html = await (await get(path, env)).text();
      expect(html, path).toMatch(/\n<body data-home="promise">\n/);
      expect(html.length, path).toBe(servedHtml.length + ' data-home="promise"'.length);
    }
    const forcedOff = await (await get('/?home=toolkit', { ...base, HOME_PROMISE_FIRST: '1' })).text();
    expect(forcedOff).toBe(servedHtml);
  });

  it('carries the promise block, hidden unless stamped, with its two taps into the toolkit', () => {
    expect(servedHtml).toContain('<section class="card" id="homePromise" data-views="home"');
    expect(servedHtml).toMatch(/#homePromise \{ display: none; \}/);
    expect(servedHtml).toContain('body[data-home="promise"]:not([data-view="focus"]):not([data-view="rest"]):not([data-view="stats"]) #homePromise { display: block; }');
    expect(servedHtml).toContain(`onclick="setView('focus')"`);
    expect(servedHtml).toContain(`onclick="setView('rest')"`);
    expect(servedHtml).toContain('href="/me/"');
  });

  it('the client honors ?home= too, and loads your words only after the session probe', () => {
    expect(servedHtml).toContain("if (h === 'promise' || h === 'toolkit') document.body.dataset.home = h;");
    expect(servedHtml).toContain('if (fbAuthenticated) { fbFlushTelemetry(); loadKeptWords(); loadHomeWords(); }');
    expect(servedHtml).toContain("fetch('/api/commitments', { cache: 'no-store' })");
    // each word links to ITS card on /me/ (the notification landing from #386)
    expect(servedHtml).toContain("a.href = '/me/?word=' + encodeURIComponent(w.id);");
    // titles are user text: textContent, never innerHTML
    const fn = servedHtml.slice(servedHtml.indexOf('function loadHomeWords()'), servedHtml.indexOf('function fmtCheckin'));
    expect(fn).not.toContain('innerHTML');
    expect(fn).toContain('title.textContent = w.title;');
  });

  it('the word-offered beacon says which home made the offer', () => {
    expect(servedHtml).toContain("home: document.body.dataset.home === 'promise' ? 'promise' : 'toolkit'");
  });
});
