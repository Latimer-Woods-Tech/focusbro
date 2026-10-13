/**
 * Site Quality Battery R-06 (TB4) — staging.focusbro.net must never be indexed.
 *
 * PLATFORM_STANDARDS §15.1: staging surfaces carry a noindex header. The
 * staging worker (wrangler [env.staging], ENV = "staging") therefore answers
 * EVERY response — pages, JSON, 404s, redirects — with `X-Robots-Tag: noindex`,
 * and its robots.txt disallows everything and names no sitemap (the production
 * sitemap lists focusbro.net URLs, which a staging crawl must not advertise).
 *
 * Production must be untouched: no X-Robots-Tag on the app shell, robots.txt
 * still allows crawling. Those cases are the rejection half — a header set
 * unconditionally would deindex focusbro.net.
 */
import { describe, expect, it } from 'vitest';
import worker, { isStagingEnv } from '../index.js';
import { call, ctx, makeEnv } from './helpers/route-kit.js';
import { DatabaseSync } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const staging = () => makeEnv({ ENV: 'staging', API_ORIGIN: 'https://staging.focusbro.net' });
const production = () => makeEnv({ ENV: 'production', API_ORIGIN: 'https://focusbro.net' });

describe('isStagingEnv', () => {
  it('is true only for ENV = "staging"', () => {
    expect(isStagingEnv({ ENV: 'staging' })).toBe(true);
    expect(isStagingEnv({ ENV: 'production' })).toBe(false);
    expect(isStagingEnv({ ENV: 'development' })).toBe(false);
    expect(isStagingEnv({ ENV: 'Staging ' })).toBe(false);
    expect(isStagingEnv({})).toBe(false);
    expect(isStagingEnv(undefined)).toBe(false);
  });
});

suite('staging responses carry X-Robots-Tag: noindex', () => {
  it.each([
    ['/health'],
    ['/'],
    ['/guides/'],
    ['/robots.txt'],
    ['/definitely-not-a-route'],
    ['/me'], // a 301
  ])('%s', async (path) => {
    const res = await call(staging(), path, { origin: null });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('the http→https redirect is noindex too (it leaves before the router)', async () => {
    const res = await worker.fetch(new Request('http://staging.focusbro.net/'), staging(), ctx);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('a HEAD /health (what the deploy job curls with -I) is 200 and noindex', async () => {
    const res = await call(staging(), '/health', { method: 'HEAD', origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('robots.txt disallows everything and advertises no sitemap', async () => {
    const res = await call(staging(), '/robots.txt', { origin: null });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^User-agent: \*$/m);
    expect(text).toMatch(/^Disallow: \/$/m);
    expect(text).not.toMatch(/^Allow:/m);
    expect(text).not.toMatch(/Sitemap/i);
  });
});

suite('production is not deindexed (rejection half)', () => {
  it.each([['/'], ['/health'], ['/guides/']])('%s has no X-Robots-Tag', async (path) => {
    const res = await call(production(), path, { origin: null });
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('an env with no ENV at all (tests, wrangler dev) is not treated as staging', async () => {
    const res = await call(makeEnv(), '/', { origin: null });
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('production robots.txt still allows crawling and names the sitemap', async () => {
    const text = await (await call(production(), '/robots.txt', { origin: null })).text();
    expect(text).toMatch(/^Allow: \/$/m);
    expect(text).not.toMatch(/^Disallow: \/$/m);
    expect(text).toContain('Sitemap: https://focusbro.net/sitemap.xml');
  });
});
