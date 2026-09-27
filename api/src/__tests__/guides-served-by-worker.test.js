/**
 * FocusBro — guide pages as the WORKER serves them.
 *
 * The smoke server renders guides by calling renderGuidePage() directly, and
 * unit tests mostly do the same — so a route handler that references `env`
 * without having it in scope passes every test and throws on every real
 * request. This drives the Worker's own fetch() for guide pages and scripts,
 * with a fake env, and asserts what production actually returns.
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

const env = { BUILD_SHA: 'abc1234', DB: undefined };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path) => worker.fetch(new Request(`https://focusbro.net${path}`), env, ctx);

describe('guide pages served by the Worker', () => {
  it('serve 200 with the build-stamped script tags', async () => {
    const res = await get('/guides/box-breathing.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<script src="/guides/view.js?v=abc1234" data-slug="box-breathing" defer></script>');
    expect(html).toContain('<section class="sources" id="sources">');
  });

  it('serve the instrument page with its versioned script', async () => {
    const res = await get('/guides/caffeine-timing-and-focus.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<script src="/guides/caffeine.js?v=abc1234" defer></script>');
  });

  it('serve the scripts: immutable for the current build, no-cache otherwise', async () => {
    const cur = await get('/guides/caffeine.js?v=abc1234');
    expect(cur.status).toBe(200);
    expect(cur.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(cur.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const stale = await get('/guides/caffeine.js?v=older');
    expect(stale.headers.get('cache-control')).toBe('no-cache');
    const bare = await get('/guides/view.js');
    expect(bare.status).toBe(200);
    expect(bare.headers.get('cache-control')).toBe('no-cache');
    expect(await bare.text()).toContain('/api/content/view');
  });
});
