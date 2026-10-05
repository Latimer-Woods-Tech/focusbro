/**
 * A kept word shows the time it was kept, in the person's own zone.
 *
 * `responded_at` is SQLite `datetime('now')` — UTC with no zone marker
 * ("2026-10-05 04:37:14"). A browser parses that form as LOCAL time, so on the
 * Android emulator (2026-10-05) a word kept at 00:37 in New York read
 * "4:37 AM". The test runs the page's own fmtWhen, extracted from the served
 * /me/ HTML, in New York time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import worker from '../index.js';

async function servedFmtWhen() {
  const r = await worker.fetch(new Request('https://focusbro.net/me/'),
    { KV_CACHE: { get: async () => null, put: async () => {} } }, { waitUntil() {} });
  expect(r.status).toBe(200);
  const html = await r.text();
  const src = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');
  const fn = src.match(/function fmtWhen\(iso\) \{[\s\S]*?\n  \}/);
  expect(fn, 'fmtWhen is in the served page').toBeTruthy();
  return new Function(`${fn[0]}; return fmtWhen;`)();
}

describe('/me/ kept time', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });

  it('reads a SQLite UTC timestamp as UTC, not local (proof: 4:37 AM before the fix)', async () => {
    const fmtWhen = await servedFmtWhen();
    process.env.TZ = 'America/New_York';
    const shown = fmtWhen('2026-10-05 04:37:14');
    expect(shown).toBe(fmtWhen('2026-10-05T04:37:14.000Z'));
    expect(shown).toMatch(/12:37:14/);
  });

  it('leaves ISO instants and junk alone', async () => {
    const fmtWhen = await servedFmtWhen();
    process.env.TZ = 'UTC';
    expect(fmtWhen('2026-10-05T04:37:14Z')).toMatch(/4:37:14/);
    expect(fmtWhen('not a date')).toBe('not a date');
  });
});
