/**
 * Site Quality Battery TB4 — the Playwright smoke can be pointed at a deployed
 * host (staging.focusbro.net) with BASE_URL, without changing the local default.
 *
 * Unset BASE_URL: the smoke serves the built html.js on localhost:4173 through
 * e2e/serve.mjs, exactly as before. Set BASE_URL: no local server is started and
 * every page.goto resolves against that host. A malformed or non-https remote
 * BASE_URL is refused, so a typo can never silently fall back to localhost and
 * report a green "staging" run that never left the runner.
 */
import { describe, expect, it } from 'vitest';
import { smokeTarget, LOCAL_BASE_URL } from '../../e2e/target.mjs';

describe('smokeTarget', () => {
  it('defaults to the local static server (unchanged behaviour)', () => {
    const t = smokeTarget({});
    expect(t.baseURL).toBe(LOCAL_BASE_URL);
    expect(LOCAL_BASE_URL).toBe('http://localhost:4173');
    expect(t.webServer).toMatchObject({ command: 'node e2e/serve.mjs', url: 'http://localhost:4173/' });
  });

  it('keeps reusing a running local server outside CI only', () => {
    expect(smokeTarget({}).webServer.reuseExistingServer).toBe(true);
    expect(smokeTarget({ CI: 'true' }).webServer.reuseExistingServer).toBe(false);
  });

  it('treats an empty BASE_URL as unset', () => {
    expect(smokeTarget({ BASE_URL: '' }).baseURL).toBe(LOCAL_BASE_URL);
    expect(smokeTarget({ BASE_URL: '   ' }).webServer).toBeDefined();
  });

  it('points at a remote https host with no local server', () => {
    const t = smokeTarget({ BASE_URL: 'https://staging.focusbro.net' });
    expect(t.baseURL).toBe('https://staging.focusbro.net');
    expect(t.webServer).toBeUndefined();
  });

  it('drops a trailing slash so "/" paths resolve once', () => {
    expect(smokeTarget({ BASE_URL: 'https://staging.focusbro.net/' }).baseURL).toBe('https://staging.focusbro.net');
  });

  it('allows an explicit http localhost target (a wrangler dev run)', () => {
    const t = smokeTarget({ BASE_URL: 'http://localhost:8787' });
    expect(t.baseURL).toBe('http://localhost:8787');
    expect(t.webServer).toBeUndefined();
  });

  it.each([
    ['staging.focusbro.net'],
    ['http://staging.focusbro.net'],
    ['ftp://staging.focusbro.net'],
    ['https://staging.focusbro.net/me/'],
  ])('refuses %s', (bad) => {
    expect(() => smokeTarget({ BASE_URL: bad })).toThrow(/BASE_URL/);
  });
});
