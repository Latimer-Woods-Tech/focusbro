/**
 * FocusBro — the breathing pacer, the second instrument.
 *
 * A pacer is the guide's counts made followable. So the counts it runs must
 * be the counts the prose describes (box 4-4-4-4 = 16 s; 4-7-8 = 19 s with NO
 * second hold), its round caps must be the guide's own safety line ("no more
 * than about four rounds"), and the arithmetic the visual and the swell follow
 * must be the one asserted here — embedded as data, never reflected through
 * the bundler. Every case FAILS on the tree before the pacer existed.
 */

import { describe, it, expect } from 'vitest';
import { BREATH_PATTERNS, BREATH_MATH_SRC, BREATH_PATTERNS_JSON, cycleSeconds, phaseAt, breathLevel, swellTarget } from '../guides/breath-patterns.js';
import { renderBreathPacer } from '../guides/breath-pacer.js';
import { BREATH_SCRIPT, GUIDE_VIEW_SCRIPT } from '../guides/scripts.js';
import { guides, renderGuidePage } from '../guides/index.js';
import servedHtml from '../html.js';
import worker from '../index.js';

const guide = (slug) => guides.find((g) => g.slug === slug);
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g)];

describe('the patterns', () => {
  it('are the counts the guides describe', () => {
    expect(BREATH_PATTERNS.box.phases.map((p) => [p.name, p.seconds])).toEqual([['Inhale', 4], ['Hold', 4], ['Exhale', 4], ['Hold', 4]]);
    expect(cycleSeconds(BREATH_PATTERNS.box.phases)).toBe(16);
    expect(BREATH_PATTERNS['478'].phases.map((p) => [p.name, p.seconds])).toEqual([['Inhale', 4], ['Hold', 7], ['Exhale', 8]]);
    expect(cycleSeconds(BREATH_PATTERNS['478'].phases)).toBe(19);
    // resonance = about six breaths a minute (Lehrer & Gevirtz 2014), no holds
    expect(cycleSeconds(BREATH_PATTERNS.resonance.phases)).toBe(10);
    expect(BREATH_PATTERNS.resonance.phases.every((p) => p.name !== 'Hold')).toBe(true);
    expect(BREATH_PATTERNS.resonance.note).toContain('Lehrer & Gevirtz, 2014');
  });

  it('4-7-8 has three phases, its exhale is the longest, and the shorter form keeps the ratio', () => {
    for (const id of ['478', '478short']) {
      const p = BREATH_PATTERNS[id];
      expect(p.phases.length, id).toBe(3);
      const secs = p.phases.map((x) => x.seconds);
      expect(Math.max(...secs)).toBe(secs[2]);
      expect(p.phases[2].name).toBe('Exhale');
    }
    // Weil's "two-and-a-half, four-and-a-half, five" — proportional to 4-7-8 within 5%
    const full = BREATH_PATTERNS['478'].phases.map((x) => x.seconds);
    const short = BREATH_PATTERNS['478short'].phases.map((x) => x.seconds);
    const ratios = short.map((s, i) => s / full[i]);
    for (const r of ratios) expect(Math.abs(r - ratios[0]) / ratios[0]).toBeLessThan(0.05);
  });

  it('caps rounds where the guide does', () => {
    // 4-7-8 guide: "Do no more than about four rounds at a time"
    expect(BREATH_PATTERNS['478'].maxRounds).toBe(4);
    expect(BREATH_PATTERNS['478short'].maxRounds).toBe(4);
    for (const p of Object.values(BREATH_PATTERNS)) {
      expect(p.defaultRounds).toBeGreaterThanOrEqual(1);
      expect(p.defaultRounds).toBeLessThanOrEqual(p.maxRounds);
      expect(p.note.length).toBeGreaterThan(20);
      expect(Object.isFrozen(p.phases)).toBe(true);
    }
    expect(BREATH_PATTERNS['478'].note).toMatch(/light-headed/);
  });
});

describe('the arithmetic', () => {
  const box = BREATH_PATTERNS.box.phases;
  const w = BREATH_PATTERNS['478'].phases;

  it('locates the phase for any moment in the cycle, wrapping', () => {
    expect(phaseAt(box, 0)).toMatchObject({ index: 0, name: 'Inhale', remaining: 4, progress: 0 });
    expect(phaseAt(box, 3.999).name).toBe('Inhale');
    expect(phaseAt(box, 4)).toMatchObject({ index: 1, name: 'Hold', elapsed: 0 });
    expect(phaseAt(box, 9)).toMatchObject({ index: 2, name: 'Exhale', elapsed: 1, remaining: 3 });
    expect(phaseAt(box, 15.5)).toMatchObject({ index: 3, name: 'Hold', remaining: 0.5 });
    expect(phaseAt(box, 16)).toMatchObject({ index: 0, name: 'Inhale' });   // wraps
    expect(phaseAt(box, 33).name).toBe('Inhale');
    expect(phaseAt(w, 11)).toMatchObject({ index: 2, name: 'Exhale', elapsed: 0 });
    expect(phaseAt(w, 18.9)).toMatchObject({ index: 2, name: 'Exhale' });
    expect(phaseAt([], 3)).toBeNull();
    expect(phaseAt(box, 'nope').name).toBe('Inhale');
  });

  it('breath level rises through an inhale, holds full, falls through an exhale, holds empty', () => {
    expect(breathLevel(box, 0)).toBe(0);
    expect(breathLevel(box, 2)).toBeCloseTo(0.5, 6);
    expect(breathLevel(box, 4)).toBe(1);        // hold after the inhale: full
    expect(breathLevel(box, 7.9)).toBe(1);
    expect(breathLevel(box, 10)).toBeCloseTo(0.5, 6);
    expect(breathLevel(box, 12)).toBe(0);       // hold after the exhale: empty
    expect(breathLevel(box, 15.9)).toBe(0);
    // 4-7-8: the seven-count hold is with the lungs full
    expect(breathLevel(w, 5)).toBe(1);
    expect(breathLevel(w, 10.9)).toBe(1);
    expect(breathLevel(w, 15)).toBeCloseTo(0.5, 6);
    // resonance never holds: a triangle wave
    const r = BREATH_PATTERNS.resonance.phases;
    expect(breathLevel(r, 5)).toBe(1);
    expect(breathLevel(r, 7.5)).toBeCloseTo(0.5, 6);
  });

  it('the swell ramps up on an inhale and down on an exhale, and a hold settles where the breath is', () => {
    expect(swellTarget(box, 0)).toEqual({ gain: 1, cutoff: 900 });
    expect(swellTarget(box, 1).gain).toBeGreaterThan(0.7);     // hold, full
    expect(swellTarget(box, 2)).toEqual({ gain: 0.1, cutoff: 300 });
    expect(swellTarget(box, 3).gain).toBeLessThan(0.1);        // hold, empty
    expect(swellTarget(w, 1).cutoff).toBeGreaterThan(swellTarget(w, 2).cutoff);
    for (const p of Object.values(BREATH_PATTERNS)) {
      for (let i = 0; i < p.phases.length; i++) {
        const t = swellTarget(p.phases, i);
        expect(t.gain).toBeGreaterThan(0); expect(t.gain).toBeLessThanOrEqual(1);
        expect(t.cutoff).toBeGreaterThan(0);                  // exponentialRamp can never target 0
      }
    }
  });
});

describe('the served script', () => {
  it('embeds the same patterns and math the tests assert — as data, never reflected', () => {
    expect(BREATH_SCRIPT).toContain(BREATH_MATH_SRC);
    expect(BREATH_SCRIPT).toContain(BREATH_PATTERNS_JSON);
    expect(JSON.parse(BREATH_PATTERNS_JSON)).toEqual(BREATH_PATTERNS);
    expect(() => new Function(BREATH_SCRIPT)).not.toThrow();
    for (const [name, src] of [['BREATH_SCRIPT', BREATH_SCRIPT], ['GUIDE_VIEW_SCRIPT', GUIDE_VIEW_SCRIPT]]) {
      expect(src, `${name} references a bundler helper`).not.toMatch(/__name\(|__publicField|__esm\(/);
      expect(src, `${name} contains reflected source`).not.toContain('.toString()');
    }
    const shipped = new Function(`${BREATH_MATH_SRC}; return { phaseAt: phaseAt, breathLevel: breathLevel };`)();
    for (const t of [0, 3.2, 4, 9, 12.5, 16, 19, 41]) {
      expect(shipped.breathLevel(BREATH_PATTERNS.box.phases, t)).toBe(breathLevel(BREATH_PATTERNS.box.phases, t));
      expect(shipped.phaseAt(BREATH_PATTERNS['478'].phases, t)).toEqual(phaseAt(BREATH_PATTERNS['478'].phases, t));
    }
  });

  it('never autoplays, keeps the screen awake for a session, and records use once through the anonymous endpoint', () => {
    // sound starts only from Start (a submit) or the checkbox (a change) — both gestures
    expect(BREATH_SCRIPT).toContain("if ($('pacerSound').checked) startAudio(0);");
    expect(BREATH_SCRIPT).not.toMatch(/autoplay/i);
    expect(BREATH_SCRIPT).toContain("navigator.wakeLock.request('screen')");
    expect(BREATH_SCRIPT).toContain("note('breathing-pacer');");
    expect(BREATH_SCRIPT).toContain("'/api/content/view'");
    expect(BREATH_SCRIPT).toContain("'focusbro_guide_tool:'");
    // the whole session's swell is laid on the audio clock, so it survives a throttled tab
    expect(BREATH_SCRIPT).toContain('linearRampToValueAtTime(tgt.gain, end)');
    expect(BREATH_SCRIPT).toContain('exponentialRampToValueAtTime(tgt.cutoff, end)');
    // honours reduced motion
    expect(BREATH_SCRIPT).toContain("'(prefers-reduced-motion: reduce)'");
  });
});

describe('the breathing guides', () => {
  it('each hosts the pacer with ONLY the patterns it describes, loaded first-party, never inline', () => {
    const cases = [['box-breathing', 'box,resonance', 'box'], ['4-7-8-breathing', '478,478short', '478']];
    for (const [slug, patterns, def] of cases) {
      const html = renderGuidePage(guide(slug), { version: 'abc1234' });
      expect(html, slug).toContain(`<section class="tool pacer" id="breathing-pacer" aria-labelledby="pacerTitle" data-patterns="${patterns}" data-default="${def}">`);
      expect(html, slug).toContain('<script src="/guides/breath.js?v=abc1234" defer></script>');
      expect(html, slug).toContain(`<script src="/guides/view.js?v=abc1234" data-slug="${slug}" defer></script>`);
      expect(inlineScripts(html), `${slug}: inline script`).toEqual([]);
      expect(html, slug).toContain('<noscript>');
      expect(html, slug).toContain('not a medical treatment');
      expect(html, slug).toContain('Nothing you do here leaves this page');
      // the pacer sits above the evidence section, in the flow of the guide
      expect(html.indexOf('id="breathing-pacer"')).toBeLessThan(html.lastIndexOf('What the evidence supports'));
      expect(guide(slug).lastmod).toBe('2026-09-04');
    }
    // the calculator page did not grow a pacer, and no other guide did either
    for (const g of guides) {
      const hosts = renderGuidePage(g).includes('id="breathing-pacer"');
      expect(hosts, g.slug).toBe(['box-breathing', '4-7-8-breathing'].includes(g.slug));
    }
  });

  it('renders the rounds select to the default pattern cap, without JavaScript', () => {
    const html = renderBreathPacer(['478', '478short'], '478');
    expect(html).toContain('<option value="4" selected>4</option>');
    expect(html).not.toContain('<option value="5">5</option>');
    expect(html).toContain('4-7-8 · 19 s a round');
    expect(html).toContain('Shorter 4-7-8 (2.5-4.5-5) · 12 s a round');
    const box = renderBreathPacer(['box', 'resonance'], 'box');
    expect(box).toContain('<option value="10">10</option>');
    expect(box).toContain('Box 4-4-4-4 · 16 s a round');
    expect(box).toContain('Resonance 5-5 (no holds) · 10 s a round');
    expect(() => renderBreathPacer(['box', 'nope'], 'box')).toThrow(/unknown pattern/);
  });
});

describe('the app the CTA opens', () => {
  it('runs 4-7-8 as three phases too — no fourth hold the guide never described', () => {
    expect(servedHtml).toContain("'478': [4,7,8]");
    expect(servedHtml).not.toContain("'478': [4,7,8,4]");
    expect(servedHtml).toContain("'478': ['Inhale','Hold','Exhale']");
    expect(servedHtml).toContain('phaseIdx = (phaseIdx + 1) % cycles.length;');
  });
});

describe('the Worker', () => {
  const env = { BUILD_SHA: 'abc1234', DB: undefined };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const req = (path, init) => worker.fetch(new Request(`https://focusbro.net${path}`, init), env, ctx);

  it('serves the pacer script, versioned, and both pages with it', async () => {
    const cur = await req('/guides/breath.js?v=abc1234');
    expect(cur.status).toBe(200);
    expect(cur.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await cur.text()).toBe(BREATH_SCRIPT);
    for (const slug of ['box-breathing', '4-7-8-breathing']) {
      const res = await req(`/guides/${slug}.html`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<script src="/guides/breath.js?v=abc1234" defer></script>');
    }
  });

  it('accepts the pacer as a known instrument on the view endpoint, and still rejects an unknown one', async () => {
    const post = (body) => req('/api/content/view', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://focusbro.net' }, body: JSON.stringify(body) });
    // no DB in this env → the record fails closed with 503, but only AFTER the allowlist passed
    const ok = await post({ slug: 'box-breathing', tool: 'breathing-pacer' });
    expect([202, 503]).toContain(ok.status);
    const bad = await post({ slug: 'box-breathing', tool: 'breathing-pacer-v2' });
    expect(bad.status).toBe(404);
  });
});
