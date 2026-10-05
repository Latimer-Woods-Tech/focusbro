/**
 * One kept-word number, one label, on both surfaces (G826).
 *
 * Seen on the Android emulator: after a not-yet the app shell's stats card read
 * 1 ("Words kept", the lifetime total) while /me/ read 0 ("Words kept in a row",
 * the current run) for the same history. /me/'s headline is now the same total
 * under the same label; the run only appears in the server's own sentences.
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { streakHeadingCopy } from '../me.js';

async function page(path) {
  const r = await worker.fetch(new Request('https://focusbro.net' + path),
    { KV_CACHE: { get: async () => null, put: async () => {} } }, { waitUntil() {} });
  expect(r.status).toBe(200);
  return r.text();
}

describe('the headline kept number', () => {
  it('/me/ shows the lifetime total, not the resetting run (proof of rejection)', async () => {
    const html = await page('/me/');
    expect(html).toContain("el('streakNum').innerHTML = esc(s.total_kept || 0)");
    expect(html).not.toContain("esc(s.current_streak || 0) + '<small>");
  });

  it('carries the same label as the shell stats card', async () => {
    const shell = await page('/');
    expect(streakHeadingCopy()).toBe('Words kept');
    expect(shell).toContain('<div class="stat-label">Words kept</div>');
    expect(await page('/me/')).toContain('<small>Words kept</small>');
    expect(await page('/me/')).not.toContain('Words kept in a row');
  });
});
