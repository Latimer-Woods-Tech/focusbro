/**
 * FocusBro — the Follow-Through Index.
 *
 * A published measure is only worth citing if its rules cannot be bent by the
 * page that shows it. These gates pin the rules: the floor below which no
 * rate (and no count) appears, the formulas matching what events.js computes,
 * the page and the JSON coming from one function, a page that renders on a
 * bad day, and a page that runs no script. Every case FAILS on the tree
 * before the Index existed.
 */

import { describe, it, expect, vi } from 'vitest';
import { FOLLOW_THROUGH, summarizeFollowThrough, followThroughFigures, renderFollowThroughPage, SAMPLE_FIGURES } from '../guides/follow-through.js';
import { SOURCES } from '../guides/sources.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../index.js';

const metrics = (kept, reschedule, missed, d7 = { eligible: 0, returned: 0 }) => ({
  window: { since: '2026-08-05T12:00:00.000Z', until: '2026-09-04T12:00:00.000Z', days: 30 },
  totals: { commitments_kept: kept, commitments_reschedule: reschedule, commitments_missed: missed, commitments_snoozed: 99, commitments_released: 7 },
  retention: { d7 },
});
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>/g)];
const lds = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));

describe('the publication rules', () => {
  it('publishes nothing below the floor — not a rate, not even the count', () => {
    const f = summarizeFollowThrough(metrics(20, 5, 4), '2026-09-04T12:00:00.000Z');   // 29 resolved
    expect(f.available).toBe(true);
    expect(f.published).toBe(false);
    expect(f.resolved).toBeNull();
    expect(f.resolved_band).toBe('fewer than 30');
    expect(f.kept_word_rate).toBeNull();
    expect(f.reschedule_rate).toBeNull();
    expect(JSON.stringify(f)).not.toContain('29');
  });

  it('publishes at the floor, with the formulas events.js computes and whole percentages', () => {
    const f = summarizeFollowThrough(metrics(19, 7, 4), '2026-09-04T12:00:00.000Z');   // exactly 30
    expect(f.published).toBe(true);
    expect(f.resolved).toBe(30);
    expect(f.kept_word_rate).toBe(63);          // 19/30 = 63.3
    expect(f.reschedule_rate).toBe(23);         // 7/30 = 23.3
    expect(f.window.days).toBe(30);
    expect(f.floors).toEqual({ resolved: 30, cohort: 30 });
    // snoozes and releases never move the rate
    expect(19 + 7 + 4).toBe(f.resolved);
  });

  it('the 7-day return has its own floor, and outreach is not the person acting (by definition, not by us)', () => {
    const below = summarizeFollowThrough(metrics(40, 5, 5, { eligible: 29, returned: 20 }));
    expect(below.return_7d).toEqual({ published: false, eligible: null, rate: null });
    const at = summarizeFollowThrough(metrics(40, 5, 5, { eligible: 30, returned: 20 }));
    expect(at.return_7d).toEqual({ published: true, eligible: 30, rate: 67 });
  });

  it('degrades to "unavailable" on nothing, never throws', () => {
    expect(summarizeFollowThrough(null, 'x')).toEqual({ available: false, generated_at: 'x' });
    expect(summarizeFollowThrough({}, 'x').available).toBe(false);
  });
});

describe('the figures pipeline', () => {
  it('serves a fresh cache hit without touching the ledger', async () => {
    const compute = vi.fn();
    const kv = { get: vi.fn(async () => SAMPLE_FIGURES), put: vi.fn() };
    const f = await followThroughFigures({ DB: {}, KV_CACHE: kv }, { compute });
    expect(f).toEqual(SAMPLE_FIGURES);
    expect(compute).not.toHaveBeenCalled();
    expect(kv.get).toHaveBeenCalledWith('follow-through:v1', 'json');
  });

  it('computes over the Index window on a miss, and caches for an hour', async () => {
    const compute = vi.fn(async () => metrics(40, 10, 10));
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const now = () => new Date('2026-09-04T12:00:00.000Z');
    const f = await followThroughFigures({ DB: {}, KV_CACHE: kv }, { compute, now });
    expect(compute).toHaveBeenCalledWith({ DB: {}, KV_CACHE: kv }, { sinceDays: 30, nowISO: '2026-09-04T12:00:00.000Z' });
    expect(f.published).toBe(true);
    expect(f.kept_word_rate).toBe(67);
    expect(kv.put).toHaveBeenCalledWith('follow-through:v1', JSON.stringify(f), { expirationTtl: 3600 });
  });

  it('never throws: no DB, a throwing ledger, or a broken cache all yield "unavailable"', async () => {
    expect((await followThroughFigures({})).available).toBe(false);
    expect((await followThroughFigures(undefined)).available).toBe(false);
    const boom = vi.fn(async () => { throw new Error('D1 down'); });
    const kv = { get: vi.fn(async () => { throw new Error('KV down'); }), put: vi.fn() };
    const f = await followThroughFigures({ DB: {}, KV_CACHE: kv }, { compute: boom });
    expect(f.available).toBe(false);
    expect(kv.put).not.toHaveBeenCalled();     // an unavailable result is never cached
  });
});

describe('the page', () => {
  it('states the floors and formulas it enforces, and cites its one research claim', () => {
    const html = renderFollowThroughPage({ available: false, generated_at: 'x' });
    expect(html).toContain('kept ÷ (kept + rescheduled + missed)');
    expect(html).toContain('at least <strong>30 resolved commitments</strong>');
    expect(html).toContain('Whole percentages');
    expect(html).toContain('Not a clinical measure');
    expect(html).toContain('Survivorship');
    expect(html).toContain(FOLLOW_THROUGH.codeUrl);
    for (const k of FOLLOW_THROUGH.sources) {
      expect(SOURCES[k]).toBeTruthy();
      expect(html).toContain(`https://doi.org/${SOURCES[k].doi}`);
    }
    expect(html).toContain('rel="author">Adrian Perry</a>');
  });

  it('never prints a rate it has not earned, and prints the stamp when it has', () => {
    const below = renderFollowThroughPage(summarizeFollowThrough(metrics(20, 5, 4), '2026-09-04T12:00:00.000Z'));
    const section = below.slice(below.indexOf('id="current-figures"'), below.indexOf('id="sources"'));
    expect(section).toContain('fewer than 30');
    expect(section).not.toMatch(/\d+%/);
    expect(section).not.toContain('29');
    expect(section).toContain('Generated: 2026-09-04 12:00 UTC');
    const pub = renderFollowThroughPage(SAMPLE_FIGURES);
    expect(pub).toContain('<dd>64%</dd>');
    expect(pub).toContain('<dd>23%</dd>');
    expect(pub).toContain('<dd>47</dd>');
    expect(pub).toContain('not yet published (fewer than 30 eligible)');
    const un = renderFollowThroughPage({ available: false, generated_at: 'x' });
    expect(un).toContain('unavailable right now');
  });

  it('is script-free and carries a Dataset whose values follow the same floor', () => {
    for (const fig of [SAMPLE_FIGURES, summarizeFollowThrough(metrics(1, 1, 1)), { available: false }]) {
      const html = renderFollowThroughPage(fig);
      expect(inlineScripts(html)).toEqual([]);
      const [dataset, crumbs] = lds(html);
      expect(dataset['@type']).toBe('Dataset');
      expect(dataset.creator['@type']).toBe('Person');
      expect(dataset.distribution.contentUrl).toBe('https://focusbro.net/api/public/follow-through');
      expect(crumbs['@type']).toBe('BreadcrumbList');
      const kept = dataset.variableMeasured.find((v) => v.name === 'Kept-word rate');
      if (fig.published) expect(kept.value).toBe(fig.kept_word_rate); else expect(kept.value).toBeUndefined();
    }
    const html = renderFollowThroughPage(SAMPLE_FIGURES);
    expect(html).toContain('<link rel="canonical" href="https://focusbro.net/follow-through-index.html" />');
    expect(html).toContain('href="/follow-through-index.html">Follow-Through Index</a>');   // footer link, every shell page
  });
});

describe('the Worker', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const get = (path, env) => worker.fetch(new Request(`https://focusbro.net${path}`), env, ctx);

  it('serves the page and the JSON from one function, cacheable, and renders without a database', async () => {
    const env = { BUILD_SHA: 'abc1234' };
    const page = await get('/follow-through-index.html', env);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await page.text()).toContain('unavailable right now');
    const json = await get('/api/public/follow-through', env);
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toMatch(/^application\/json/);
    expect(json.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(json.headers.get('access-control-allow-origin')).toBe('*');
    expect(await json.json()).toMatchObject({ available: false });
  });

  it('serves cached figures to both surfaces identically', async () => {
    const env = { BUILD_SHA: 'abc1234', DB: {}, KV_CACHE: { get: async () => SAMPLE_FIGURES, put: async () => {} } };
    expect(await (await get('/api/public/follow-through', env)).json()).toEqual(SAMPLE_FIGURES);
    expect(await (await get('/follow-through-index.html', env)).text()).toContain('<dd>64%</dd>');
  });

  it('is in the sitemap with its lastmod', async () => {
    const xml = await (await get('/sitemap.xml', {})).text();
    expect(xml).toContain(`<url><loc>https://focusbro.net/follow-through-index.html</loc><lastmod>${FOLLOW_THROUGH.lastmod}</lastmod></url>`);
  });
});

describe('no shell page carries the same id twice', () => {
  it('guide pages and the Index page have unique ids (the Sources section used to collide with its own heading)', async () => {
    const { guides, renderGuidePage } = await import('../guides/index.js');
    const dupes = (html) => { const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]); return [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))]; };
    for (const g of guides) expect(dupes(renderGuidePage(g)), g.slug).toEqual([]);
    expect(dupes(renderFollowThroughPage(SAMPLE_FIGURES))).toEqual([]);
    // and the TOC still reaches the Sources section by its existing id
    expect(renderGuidePage(guides[0])).toContain('<a href="#sources">Sources</a>');
  });
});

describe('the definitions match the code they describe', () => {
  it('events.js counts resolved the same way the page says', () => {
    const events = readFileSync(fileURLToPath(new URL('../events.js', import.meta.url)), 'utf8');
    expect(events).toContain('const resolved = totals.commitments_kept + totals.commitments_reschedule + totals.commitments_missed;');
    expect(events).toContain('kept_word_rate = resolved > 0 ? round2(totals.commitments_kept / resolved)');
    // the snooze is kept OUT of resolved in the code, and the page says so
    expect(events).toContain('deliberately kept OUT of');
    expect(events).toContain('commitments_snoozed: by_type[EVENTS.COMMITMENT_SNOOZE] || 0,');
    expect(renderFollowThroughPage({ available: false })).toContain('deliberately kept out of every rate on this page');
  });
});
