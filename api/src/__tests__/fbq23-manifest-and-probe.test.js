/**
 * FBQ-23 — the manifest shortcuts and the quiet session probe.
 *
 * Verified live 2026-10-05: the manifest advertised `/?view=pomodoro` and
 * `/?view=breathing`, and the shell's deep-link handler only reads `?tool=`, so
 * both home-screen shortcuts opened a cold dashboard.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import servedHtml from '../html.js';
import { TOOL_DEEPLINK_IDS } from '../guides/index.js';

const stmt = { bind() { return stmt; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = { JWT_SECRET: 'test-secret', BUILD_SHA: 'test', KV_CACHE: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };
const get = (path) => worker.fetch(new Request(`https://focusbro.net${path}`), env, { waitUntil() {} });

describe('manifest shortcuts', () => {
  it('every shortcut is a ?tool=<id> link whose id the shell handler and the guides both know', async () => {
    const manifest = await (await get('/manifest.json')).json();
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    // the ids the served shell's TOOL_DEEPLINKS map actually opens
    const block = servedHtml.slice(servedHtml.indexOf('const TOOL_DEEPLINKS = {'));
    const handled = new Set([...block.slice(0, block.indexOf('};')).matchAll(/^\s{2}([a-z]+):\s/gm)].map((m) => m[1]));
    expect(handled.has('breathing')).toBe(true); // the extraction itself works
    for (const s of manifest.shortcuts) {
      const u = new URL(s.url, 'https://focusbro.net');
      expect(u.pathname, s.url).toBe('/');
      expect(u.searchParams.has('view'), `${s.url} uses ?view=, which nothing reads`).toBe(false);
      const id = u.searchParams.get('tool');
      expect(id, `${s.url} must carry ?tool=`).toBeTruthy();
      expect(handled.has(id), `${id} has no handler in the shell`).toBe(true);
      expect(TOOL_DEEPLINK_IDS.includes(id), `${id} is not in TOOL_DEEPLINK_IDS`).toBe(true);
    }
  });
});

describe('GET /auth/session?probe=1', () => {
  it('answers an anonymous visitor 200 {authenticated:false}, while a plain GET keeps its 401', async () => {
    const quiet = await get('/auth/session?probe=1');
    expect(quiet.status).toBe(200);
    expect(await quiet.json()).toEqual({ authenticated: false });
    const plain = await get('/auth/session');
    expect(plain.status).toBe(401);
    expect(await plain.json()).toEqual({ authenticated: false });
  });
});
