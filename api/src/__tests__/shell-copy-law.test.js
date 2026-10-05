/**
 * The design LAW, applied to the app shell (public/index.html → html.js).
 *
 * Every server-rendered surface (/me/, coach, consent, onboarding) has been held
 * to `design-law.js` since issue #10. The app shell — the page most people see
 * first, and the one with the most copy — never was: its strings live inline in
 * one HTML file, so no `*CopySurface()` export ever collected them. This test
 * collects them itself: visible text nodes, the copy-bearing attributes
 * (placeholder / title / aria-label), and the in-script copy that reaches the
 * screen (toasts, the tip arrays, the focus-level ladder).
 *
 * The shell is also the SEO landing page ("ADHD tools, focus timer…" are its
 * meta keywords), so the bare word "ADHD" is allowed here the way it is on the
 * guides (`allowAdhd: true`). Shame, treatment claims and "AI" branding are not.
 *
 * Out of scope on purpose: the legal modal (privacy / terms text is a contract,
 * not product voice) and the `<svg>` sprite (no copy).
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';
import { scanDesignLaw } from '../design-law.js';

const decode = (s) => s
  .replace(/&rsquo;|&#8217;/g, '’').replace(/&lsquo;/g, '‘')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/**
 * Pull every string a person can read out of the shell.
 * @param {string} html
 * @returns {string[]}
 */
export function shellCopySurface(html) {
  let body = html.slice(html.indexOf('<body'));
  // The legal modal is the last markup before the closing scripts; drop it up
  // to the next <script> tag (it contains none of its own).
  body = body.replace(/<div id="legalModal"[\s\S]*?(?=<script)/, '');
  const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const markup = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');

  const out = [];
  for (const m of markup.matchAll(/>([^<>]+)</g)) {
    const t = decode(m[1]).replace(/\s+/g, ' ').trim();
    if (t.length > 1) out.push(t);
  }
  for (const m of markup.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]+)"/g)) {
    out.push(decode(m[1]).trim());
  }
  const js = scripts.join('\n');
  // In-script copy that reaches the screen: toasts, tips, labels.
  for (const m of js.matchAll(/showToast\(\s*(['"`])((?:\\\1|(?!\1).)*)\1/g)) out.push(m[2]);
  for (const m of js.matchAll(/"([^"\n]*<strong>[^"\n]*)"/g)) out.push(decode(m[1].replace(/<[^>]+>/g, '')));
  for (const m of js.matchAll(/label:\s*'([^'\n]+)'/g)) out.push(m[1]);
  for (const m of js.matchAll(/(?:name|desc):\s*'((?:\\'|[^'\n])+)'/g)) out.push(m[1].replace(/\\'/g, "'"));
  return out;
}

describe('design LAW — the app shell', () => {
  const surface = shellCopySurface(servedHtml);

  it('actually sees the page (not an empty surface passing vacuously)', () => {
    expect(surface.length).toBeGreaterThan(150);
    expect(surface.some((s) => s.startsWith('The check-in that follows up'))).toBe(true);
    expect(surface).toContain('What are you avoiding?'); // placeholder
    expect(surface.some((s) => /Body doubling/.test(s))).toBe(true); // tip array (in-script)
  });

  it('carries no shame, no treatment claim, no "AI" branding', () => {
    const hits = [];
    for (const s of surface) {
      for (const v of scanDesignLaw(s, { allowAdhd: true })) hits.push(`${v.kind} ${v.pattern}: "${s.slice(0, 90)}"`);
    }
    expect(hits).toEqual([]);
  });

  it('would catch a violation (proof of rejection)', () => {
    const bad = '<body><div class="card">You failed again?! Lazy.</div><input placeholder="Treat your disorder"><script>showToast("Built with AI");</script></body>';
    const strings = shellCopySurface(bad);
    const kinds = strings.flatMap((s) => scanDesignLaw(s, { allowAdhd: true }).map((v) => v.kind));
    expect(kinds).toContain('shame');
    expect(kinds).toContain('treatment');
    expect(kinds).toContain('ai-branding');
  });
});
