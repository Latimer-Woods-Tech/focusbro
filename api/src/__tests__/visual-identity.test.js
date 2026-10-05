/**
 * One visual identity (2026-10 refresh): the mark, real raster icons, and an
 * icon system instead of emoji.
 *
 * What must not drift back:
 *  - emoji as iconography in the app shell — on ChromeOS/Android they render as
 *    cartoon Noto glyphs, which is what made the product read as unfinished;
 *  - an icon reference with no matching sprite symbol (renders as nothing);
 *  - "PNG" routes that serve SVG, or a share image that 404s — installable-PWA
 *    checks and link previews both need real PNGs at the advertised size;
 *  - three different brand colours across favicon, PWA icon and app.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';
import worker from '../index.js';
import { brandAssetResponse, BRAND, MARK_SVG } from '../brand-assets.js';
import { pageShellStyle } from '../page-shell.js';

const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = { JWT_SECRET: 'test-secret', BUILD_SHA: 'test', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };
const get = (path) => worker.fetch(new Request(`https://focusbro.net${path}`), env, { waitUntil() {} });

// Pictographic emoji; typographic marks (✓ ✕ ⌘ ⌃) are allowed.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B50}\u{23E9}-\u{23FA}\u{1F000}-\u{1F2FF}]/u;
const ALLOWED = new Set(['✓', '✕', '⌘', '⌃']);

function pngSize(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => bytes[i] === b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

describe('icon system', () => {
  it('the app shell uses no emoji as iconography', () => {
    const hits = [...servedHtml.matchAll(new RegExp(EMOJI.source, 'gu'))].map((m) => m[0]).filter((c) => !ALLOWED.has(c));
    expect(hits).toEqual([]);
  });

  it('the guard actually catches an emoji (proof of rejection)', () => {
    expect(EMOJI.test('<span class="icon">🍅</span>')).toBe(true);
    expect(EMOJI.test('Toggle ⌘K ✓')).toBe(false);
  });

  it('every icon the page references has a sprite symbol', () => {
    const symbols = new Set([...servedHtml.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
    const used = new Set([
      ...[...servedHtml.matchAll(/href="#i-([a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...servedHtml.matchAll(/fbIcon\('([a-z0-9-]+)'\)/g)].map((m) => m[1]),
      ...[...servedHtml.matchAll(/icon\s*:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
    ]);
    expect(symbols.size).toBeGreaterThan(40);
    expect([...used].filter((n) => !symbols.has(n))).toEqual([]);
  });

  it('the skip link is hidden until focused on every screen size', () => {
    // It used to hide only inside the ≤960px query, so it showed on laptops.
    expect(servedHtml).toMatch(/\n  \.skip-link \{[^}]*top: -48px/);
  });
});

describe('brand assets', () => {
  for (const [path, w, h] of [['/icon-192.png', 192, 192], ['/icon-512.png', 512, 512], ['/og.png', 1200, 630]]) {
    it(`${path} is a real ${w}×${h} PNG`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ w, h });
    });
  }

  it('the favicon and the long-404 /icon-192.svg serve the mark', async () => {
    for (const path of ['/favicon.ico', '/icon-192.svg', '/mark.svg']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
      expect(await res.text()).toBe(MARK_SVG);
    }
  });

  it('unknown names are not brand assets', () => {
    expect(brandAssetResponse('icon-9000.png')).toBeNull();
  });

  it('manifest, page meta and shared page shell agree on the brand colours', async () => {
    const manifest = await (await get('/manifest.json')).json();
    expect(manifest.theme_color).toBe(BRAND.ink);
    expect(manifest.icons.some((i) => i.src === '/icon-512.png' && /maskable/.test(i.purpose))).toBe(true);
    expect(servedHtml).toContain(`--primary: ${BRAND.amber}`);
    expect(servedHtml).toContain(`content="${BRAND.ink}"`);
    expect(MARK_SVG).toContain(BRAND.amber);
    expect(pageShellStyle()).toContain(`--primary: ${BRAND.amber}`);
    expect(pageShellStyle()).not.toMatch(/#0ea5e9|#0a0e27|#6366f1/i);
  });

  it('the share card is wired into the app shell', () => {
    expect(servedHtml).toContain('property="og:image" content="https://focusbro.net/og.png"');
  });
});
