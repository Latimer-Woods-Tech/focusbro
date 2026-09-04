/**
 * FocusBro — the evidence ledger gates.
 *
 * AdSense's verdict on this site was "Low value content" (Factory G300). The
 * guides made 52 "research" claims with ZERO outbound links and an
 * Organization as author — accurate, but unverifiable as shipped, and
 * indistinguishable from scaled content. These gates make the opposite true:
 * every guide either cites typed, DOI-linked sources with an honest caveat, or
 * says plainly that it makes no research claim. The music guide must carry the
 * failed replication of the study it discusses, not just the headline.
 *
 * Every case here FAILS on the tree before the ledger existed.
 */

import { describe, it, expect } from 'vitest';
import { guides, renderGuidePage } from '../guides/index.js';
import { SOURCES, SOURCE_TYPES, AUTHOR, sourceUrl } from '../guides/sources.js';

const DOI = /^10\.\d{4,9}\/\S+$/;
const firstLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));

describe('the source registry', () => {
  it('every DOI is well-formed and every peer-reviewed source carries one', () => {
    for (const [key, src] of Object.entries(SOURCES)) {
      expect(SOURCE_TYPES[src.type], `${key}: unknown type ${src.type}`).toBeTruthy();
      if (src.doi) expect(src.doi, `${key}: malformed DOI`).toMatch(DOI);
      if (['study', 'meta', 'review', 'report'].includes(src.type)) {
        expect(src.doi, `${key}: a ${src.type} must be DOI-linked, or typed honestly as something else`).toMatch(DOI);
      }
      expect(src.authors && src.title && src.venue, `${key}: incomplete`).toBeTruthy();
    }
  });

  it('a book, essay or guidance is never dressed up with a DOI it does not have', () => {
    for (const [key, src] of Object.entries(SOURCES)) {
      if (['book', 'essay', 'guidance'].includes(src.type)) {
        expect(src.doi, `${key}`).toBeUndefined();
        // guidance may link to the publishing body's own page; nothing else links at all
        if (src.type === 'guidance' && src.url) expect(sourceUrl(src)).toBe(src.url);
        else expect(sourceUrl(src)).toBeNull();
      }
    }
  });

  it('carries the failed replication, not just the headline', () => {
    // The whole point of a ledger: the 1993 "Mozart effect" letter is cited
    // alongside the 2010 meta-analysis that found little to no effect.
    expect(SOURCES.rauscher1993.note).toMatch(/did not hold up/i);
    expect(SOURCES.pietschnig2010.type).toBe('meta');
    const music = guides.find((g) => g.slug === 'music-and-noise-for-focus');
    expect(music.sources).toContain('rauscher1993');
    expect(music.sources).toContain('pietschnig2010');
  });
});

describe('every guide', () => {
  it('either cites typed sources or states that it makes no research claim', () => {
    for (const g of guides) {
      expect(Array.isArray(g.sources), `${g.slug}: no sources array`).toBe(true);
      if (g.sources.length === 0) {
        expect(g.evidenceNote, `${g.slug}: cites nothing and does not say so`).toMatch(/no research claim/i);
      }
      for (const k of g.sources) expect(SOURCES[k], `${g.slug}: unknown source key "${k}"`).toBeTruthy();
    }
  });

  it('renders a Sources section built from the same data as the JSON-LD citations', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      expect(html, `${g.slug}: no Sources section`).toContain('<section class="sources" id="sources">');
      const ld = firstLd(html);
      expect(Array.isArray(ld.citation), `${g.slug}: no citation[]`).toBe(true);
      expect(ld.citation.length).toBe(g.sources.length);
      for (const k of g.sources) {
        const src = SOURCES[k];
        if (src.doi) {
          expect(html, `${g.slug}: ${k} DOI link missing`).toContain(`https://doi.org/${src.doi}`);
          expect(ld.citation.some((c) => c.url === `https://doi.org/${src.doi}`), `${g.slug}: ${k} not in citation[]`).toBe(true);
        }
      }
    }
  });

  it('is written by a person, not an organisation', () => {
    for (const g of guides) {
      const ld = firstLd(renderGuidePage(g));
      expect(ld.author['@type']).toBe('Person');
      expect(ld.author.name).toBe(AUTHOR.name);
      expect(renderGuidePage(g)).toContain(`rel="author">${AUTHOR.name}</a>`);
    }
  });

  it('is instrumented: the CTA carries its content-ledger ref and the page records a view', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      expect(html, `${g.slug}: CTA carries no ref`).toMatch(new RegExp(`class="app-cta" href="/\\?tool=[a-z]+&amp;ref=cf_focusbro_${g.slug}"`));
      // The beacon is a FIRST-PARTY script, never inline: the site's CSP is
      // script-src 'self', and a guide page must stay clean under it.
      expect(html, `${g.slug}: no view beacon`).toContain(`<script src="/guides/view.js" data-slug="${g.slug}" defer></script>`);
      expect(html, `${g.slug}: inline beacon would violate script-src 'self'`).not.toContain("'/api/content/view'");
    }
  });
});
