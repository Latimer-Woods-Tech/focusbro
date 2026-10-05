/**
 * FBQ-24 R2 — the page, redirect and static routes QA listed as unhit. Low risk,
 * but a routing regression (a page 404s, a redirect loops, robots.txt stops
 * pointing at the sitemap) is invisible without a request. Each route is asked
 * through worker.fetch and must answer the status, type and cache policy it is
 * meant to; the redirects must land on a route that itself answers 200.
 */
import { describe, expect, it } from 'vitest';
import { call, makeEnv } from './helpers/route-kit.js';
import { DatabaseSync } from './helpers/real-d1.js';

const suite = DatabaseSync ? describe : describe.skip;
const get = (path) => call(makeEnv(), path, { origin: null });

suite('static pages and redirects', () => {
  it.each([
    ['/terms.html', 'public, max-age=300'],
    ['/contact.html', 'public, max-age=300'],
    ['/me/report/', 'no-store'],
    ['/account/delete', null],
    // itty-router matches a trailing slash on the same route, so the explicit 301 handler below it never runs
    ['/account/delete/', null],
  ])('%s answers 200 HTML', async (path, cache) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    if (cache) expect(res.headers.get('Cache-Control')).toBe(cache);
    expect((await res.text()).toLowerCase()).toContain('<!doctype html>');
  });

  it.each([
    ['/me', '/me/'],
    ['/coach', '/coach/'],
    ['/guides', '/guides/'],
    ['/pro', '/pro/'],
  ])('%s redirects (301) to %s, which answers 200', async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(to);
    expect((await get(to)).status).toBe(200);
  });

  it('robots.txt allows crawling and names the sitemap', async () => {
    const res = await get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Sitemap: https://focusbro.net/sitemap');
  });

  it('/api/gallery answers JSON, empty and honest when no images exist', async () => {
    const res = await get('/api/gallery');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { images: [] } });
  });
});
