/**
 * FocusBro — AdSense loader presence gate (Factory G297).
 *
 * The loader was correctly KEPT by the Phase 1 compliance PR (`3b9a2e9`,
 * 2026-07-04) — focusbro#6 says in as many words "KEEP the adsbygoogle.js
 * <script> (ownership)". Seven days later `b70887e4`, an unrelated hardening
 * PR, rewrote public/index.html by +28/-90 and the loader left with the 90.
 *
 * It stayed gone for six weeks and across TWO AdSense reviews, while the
 * homepage consent banner kept telling visitors "We use Google AdSense".
 *
 * Nothing could see it go, because Phase 1's acceptance criteria asserted only
 * the ABSENCE of the placeholder markup ("no 'Ad Space' text, no
 * data-ad-slot") and never the PRESENCE of the loader. This file is that
 * missing half: a revenue-critical third-party tag that lives in source as a
 * string needs a test, or any refactor can delete it silently.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';
import { guides, renderGuidePage } from '../guides/index.js';

const PUBLISHER = 'ca-pub-1346297152611586';

describe('the AdSense loader', () => {
  it('is present on the homepage — the page a reviewer lands on', () => {
    expect(servedHtml).toContain('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
    expect(servedHtml).toContain(PUBLISHER);
  });

  it('uses the same publisher id everywhere, including /ads.txt', () => {
    // The 2026-07-04 rejection listed the ads.txt/page mismatch as an outright
    // disqualifier: commit 7a16a3f changed the page and not the file.
    const ids = new Set([...servedHtml.matchAll(/ca-pub-(\d+)/g)].map((m) => m[1]));
    expect([...ids]).toEqual([PUBLISHER.replace('ca-pub-', '')]);
    expect(servedHtml).not.toContain('7015938501859914');
  });

  it('is present on every guide page — the content layer ads run against', () => {
    for (const g of guides) {
      const html = renderGuidePage(g);
      expect(html, `guide ${g.slug} has no AdSense loader`).toContain('adsbygoogle.js');
      expect(html, `guide ${g.slug} has the wrong publisher`).toContain(PUBLISHER);
    }
  });

  it('carries no placeholder ad markup — that read as under construction', () => {
    expect(servedHtml).not.toContain('data-ad-slot="XXXXXXXXXX"');
    expect(servedHtml).not.toMatch(/Ad Space\s*[—-]/);
  });

  it('does not claim AdSense in the consent banner without shipping it', () => {
    // The banner said "We use Google AdSense, which may set cookies" on a page
    // that contained no ad code at all. Either both, or neither.
    if (/We use Google AdSense/i.test(servedHtml)) {
      expect(servedHtml).toContain('adsbygoogle.js');
    }
  });
});
