/**
 * FocusBro — Guide → tool deep-link tests (Contender #10, Phase A · L4).
 *
 * L4 (docs/IMPROVEMENT_PLAN.md) is the cheapest reader→user conversion: every
 * guide ends with ONE action that opens the matching tool state in the app via
 * `/?tool=<id>`, instead of dropping the reader on a cold dashboard at `/`.
 *
 * These tests pin three things so the conversion path can't silently rot:
 *  1. Every guide CTA is a `/?tool=<id>` deep-link whose id the app can handle
 *     (id ∈ TOOL_DEEPLINK_IDS) — no bare `href="/"` CTAs remain.
 *  2. Each guide page carries valid schema.org Article structured data plus
 *     Open Graph + Twitter card meta (the SEO/share half of L4).
 *  3. The served app (html.js) actually ships the deep-link handler + a map
 *     entry for every id a guide targets — so a link can never point at a
 *     tool the app won't open.
 */

import { describe, it, expect } from 'vitest';
import { guides, renderGuidePage, renderGuidesIndex, TOOL_DEEPLINK_IDS } from '../guides/index.js';
import servedHtml from '../html.js';

// Pull every app-cta href out of a rendered guide page.
function ctaHrefs(html) {
  return [...html.matchAll(/class="app-cta" href="([^"]+)"/g)].map((m) => m[1]);
}

describe('TOOL_DEEPLINK_IDS', () => {
  it('is a non-empty frozen set of lowercase-letter ids', () => {
    expect(Array.isArray(TOOL_DEEPLINK_IDS)).toBe(true);
    expect(TOOL_DEEPLINK_IDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(TOOL_DEEPLINK_IDS)).toBe(true);
    for (const id of TOOL_DEEPLINK_IDS) expect(id).toMatch(/^[a-z]+$/);
  });
});

describe('guide CTAs are tool deep-links', () => {
  it('every guide renders exactly one CTA and it is a valid /?tool=<id> link', () => {
    for (const g of guides) {
      const hrefs = ctaHrefs(renderGuidePage(g));
      expect(hrefs.length, `guide ${g.slug} should have one app CTA`).toBe(1);
      const m = hrefs[0].match(/^\/\?tool=([a-z]+)$/);
      expect(m, `guide ${g.slug} CTA "${hrefs[0]}" must be /?tool=<id>`).not.toBeNull();
      expect(TOOL_DEEPLINK_IDS, `guide ${g.slug} targets unknown tool ${m && m[1]}`).toContain(m[1]);
    }
  });

  it('no guide CTA points at the bare app root anymore', () => {
    for (const g of guides) {
      expect(renderGuidePage(g)).not.toContain('class="app-cta" href="/"');
    }
  });

  it('the 20-20-20 guide opens the Eye Rest tool, not the Movement Break modal', () => {
    // Regression: the CTA read "Try the Eye Rest tool" but deep-linked to
    // /?tool=movement, which opens the cardio Movement Break — the wrong tool.
    // Eye Rest is the 20-20-20 Break Reminder; it must land there.
    const g = guides.find((x) => x.slug === 'the-20-20-20-rule');
    expect(g, 'the 20-20-20 guide should exist').toBeTruthy();
    const hrefs = ctaHrefs(renderGuidePage(g));
    expect(hrefs).toContain('/?tool=eyerest');
    expect(hrefs).not.toContain('/?tool=movement');
    expect(TOOL_DEEPLINK_IDS).toContain('eyerest');
  });

  it('the music-and-noise guide opens the Ambient Sounds card, not the bare Restore view', () => {
    // A reader who came for music/sounds landed on /?tool=rest, which only
    // switches to the Restore view and drops them among breathing, fidgets,
    // and meditation — they have to hunt for the sounds panel. It must target
    // /?tool=sounds, which rings the Ambient Sounds card specifically.
    const g = guides.find((x) => x.slug === 'music-and-noise-for-focus');
    expect(g, 'the music-and-noise guide should exist').toBeTruthy();
    const hrefs = ctaHrefs(renderGuidePage(g));
    expect(hrefs).toContain('/?tool=sounds');
    expect(hrefs).not.toContain('/?tool=rest');
    expect(TOOL_DEEPLINK_IDS).toContain('sounds');
  });
});

describe('guide pages carry structured data + social meta', () => {
  it('each page has valid schema.org Article JSON-LD keyed to the guide', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(m, `guide ${g.slug} missing JSON-LD`).not.toBeNull();
      // The </-escape must keep the payload parseable.
      const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
      expect(data['@type']).toBe('Article');
      expect(data.headline).toBe(g.title);
      expect(data.url).toBe(`https://focusbro.net/guides/${g.slug}.html`);
      expect(data.publisher && data.publisher.name).toBe('FocusBro');
    }
  });

  it('each page has Open Graph + Twitter card meta', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      expect(html).toContain('property="og:type" content="article"');
      expect(html).toContain('property="og:title"');
      expect(html).toContain(`property="og:url" content="https://focusbro.net/guides/${g.slug}.html"`);
      expect(html).toContain('name="twitter:card" content="summary"');
    }
  });

  it('escapes attribute-breaking characters in meta values', () => {
    const html = renderGuidePage({
      slug: 'x',
      title: 'Focus & "flow"',
      description: 'a <tag> & "quote"',
      lastmod: '2026-07-13',
      body: '<p>hi</p>',
    });
    expect(html).toContain('content="Focus &amp; &quot;flow&quot;"'); // og:title escaped
    expect(html).not.toContain('content="a <tag>'); // description escaped, not raw
  });
});

describe('the served app can honor every deep-link a guide uses', () => {
  it('html.js ships the deep-link handler and map', () => {
    expect(servedHtml).toContain('const TOOL_DEEPLINKS');
    expect(servedHtml).toContain('initToolDeepLink');
  });

  it('every tool id used by a guide CTA has a handler entry in the served app', () => {
    const usedIds = new Set();
    for (const g of guides) {
      for (const href of ctaHrefs(renderGuidePage(g))) {
        const m = href.match(/^\/\?tool=([a-z]+)$/);
        if (m) usedIds.add(m[1]);
      }
    }
    for (const id of usedIds) {
      // The handler map is `{ focus: ..., breathing: ..., ... }` — assert a key exists.
      expect(servedHtml, `served app has no TOOL_DEEPLINKS entry for "${id}"`).toMatch(
        new RegExp(`\\b${id}:\\s*\\(\\)\\s*=>`)
      );
    }
  });

  it('the sounds deep-link rings the Ambient Sounds card, not just the Restore view', () => {
    // Behavior, not just presence: `sounds` must route through the shared
    // ring-a-card helper anchored on the Ambient Sounds volume control, the
    // same mechanism `eyerest` uses — so the reader lands ON the card.
    expect(servedHtml).toContain('function deepLinkToRestCard');
    expect(servedHtml).toMatch(/sounds:\s*\(\)\s*=>\s*deepLinkToRestCard\('soundVolume'\)/);
    expect(servedHtml).toMatch(/eyerest:\s*\(\)\s*=>\s*deepLinkToRestCard\('breakToggle'\)/);
    // The helper must flash the matched card (the warm "you're here" signal).
    expect(servedHtml).toContain("card.classList.add('deeplink-flash')");
  });
});

describe('design LAW — deep-link CTAs stay warm and clean', () => {
  it('no CTA copy shames, and no bare-word "AI" appears on a guide page', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      expect(html).not.toMatch(/\bAI\b/);
      const cta = html.match(/class="app-cta"[^>]*>([^<]+)</);
      expect(cta).not.toBeNull();
      expect(cta[1].toLowerCase()).not.toMatch(/fail|lazy|behind|missed|guilt|should have/);
    }
  });

  it('the /guides/ index still renders as cards', () => {
    const idx = renderGuidesIndex(guides);
    expect(idx).toContain('class="card"');
  });
});
