/**
 * FocusBro — the caffeine half-life calculator, the first instrument.
 *
 * A guide that computes something cannot be called thin, and it must be
 * honest: its arithmetic, its default, and its range come from cited sources
 * (IOM 2001, doi:10.17226/10219), its presets from the FDA's published
 * figures, and the prose above it must say the same number the widget uses.
 * The math lives in ONE module that both these tests and the served script
 * embed, so the client can never drift from what is asserted here.
 */

import { describe, it, expect } from 'vitest';
import { remainingMg, hoursUntil, hoursBetween, CAFFEINE_MATH_SRC, HALF_LIFE_DEFAULT_H, HALF_LIFE_MIN_H, HALF_LIFE_MAX_H } from '../guides/caffeine-math.js';
import { CAFFEINE_SCRIPT, GUIDE_VIEW_SCRIPT } from '../guides/scripts.js';
import { guides, renderGuidePage } from '../guides/index.js';
import { SOURCES } from '../guides/sources.js';

const guide = () => guides.find((g) => g.slug === 'caffeine-timing-and-focus');

describe('the arithmetic', () => {
  it('is first-order elimination with the IOM default and range', () => {
    expect(HALF_LIFE_DEFAULT_H).toBe(5);
    expect(HALF_LIFE_MIN_H).toBe(1.5);
    expect(HALF_LIFE_MAX_H).toBe(9.5);
    expect(remainingMg(400, 5, 5)).toBeCloseTo(200, 6);
    expect(remainingMg(400, 10, 5)).toBeCloseTo(100, 6);
    expect(remainingMg(200, 8, 5)).toBeCloseTo(65.98, 1);
    expect(remainingMg(100, 0, 5)).toBe(100);
  });

  it('never produces nonsense on bad input', () => {
    expect(remainingMg(-5, 3, 5)).toBe(0);
    expect(remainingMg(100, -3, 5)).toBe(100);   // negative elapsed clamps to 0
    expect(remainingMg(100, 3, 0)).toBe(0);
    expect(hoursUntil(100, 200, 5)).toBe(0);     // already below target
    expect(hoursUntil(400, 25, 5)).toBeCloseTo(20, 6);
    expect(hoursBetween('15:00', '23:00')).toBe(8);
    expect(hoursBetween('22:00', '06:00')).toBe(8);  // wraps past midnight
    expect(hoursBetween('nope', '23:00')).toBeNull();
  });
});

describe('the served script', () => {
  it('embeds the same math the tests assert — as the source string, never reflected', () => {
    expect(CAFFEINE_SCRIPT).toContain(CAFFEINE_MATH_SRC);
    expect(() => new Function(CAFFEINE_SCRIPT)).not.toThrow();
    expect(() => new Function(GUIDE_VIEW_SCRIPT)).not.toThrow();
  });

  it('survives the Worker bundler: no bundler helpers, no reflected function source', () => {
    // Production runs the wrangler/esbuild bundle, which wraps declarations in
    // `__name(...)`. A script built from Function.prototype.toString() carried
    // that helper into the browser and the calculator was dead on the live
    // site while every local test passed. The served scripts must be plain
    // string data, and must never reference a bundler helper.
    for (const [name, src] of [['CAFFEINE_SCRIPT', CAFFEINE_SCRIPT], ['GUIDE_VIEW_SCRIPT', GUIDE_VIEW_SCRIPT]]) {
      expect(src, `${name} references a bundler helper`).not.toMatch(/__name\(|__publicField|__esm\(/);
      expect(src, `${name} contains reflected source`).not.toContain('.toString()');
    }
    // and the module's callable math is built FROM the string it ships
    const shipped = new Function(`${CAFFEINE_MATH_SRC}; return remainingMg;`)();
    for (const [d, h, hl] of [[400, 5, 5], [200, 8, 5], [90, 3, 1.5], [300, 12, 9.5]]) {
      expect(shipped(d, h, hl)).toBe(remainingMg(d, h, hl));
    }
  });

  it('reports tool use through the same anonymous endpoint, once per session', () => {
    expect(CAFFEINE_SCRIPT).toContain("'/api/content/view'");
    expect(CAFFEINE_SCRIPT).toContain("tool: tool");
    expect(CAFFEINE_SCRIPT).toContain("'focusbro_guide_tool:'");
  });
});

describe('the caffeine guide', () => {
  it('hosts the instrument and loads it as a first-party script, never inline', () => {
    const html = renderGuidePage(guide());
    expect(html).toContain('<section class="tool" id="caffeine-calculator"');
    expect(html).toContain('<script src="/guides/caffeine.js" defer></script>');
    expect(html).toContain('<noscript>');
    // no inline execution: the only <script> elements are ld+json or src= tags
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g)];
    expect(inline).toEqual([]);
  });

  it('says the same half-life the calculator uses, and cites it', () => {
    const html = renderGuidePage(guide());
    expect(html).toContain('half-life is about five hours on average');
    expect(html).toContain('1.5 to 9.5 hours');
    expect(html).not.toContain('five to six hours');
    expect(guide().sources).toEqual(expect.arrayContaining(['iom2001', 'fredholm1999', 'fda_caffeine', 'drake2013']));
    expect(SOURCES.iom2001.doi).toBe('10.17226/10219');
    expect(html).toContain('https://doi.org/10.17226/10219');
  });

  it('presets are the FDA figures, and the source says so', () => {
    const html = renderGuidePage(guide());
    for (const mg of ['71', '37']) expect(html).toContain(`<option value="${mg}">`);
    expect(html).toContain('113–247 mg');
    expect(SOURCES.fda_caffeine.type).toBe('guidance');
    expect(SOURCES.fda_caffeine.url).toMatch(/^https:\/\/www\.fda\.gov\//);
    expect(html).toContain(SOURCES.fda_caffeine.url);
  });

  it('is honest about what it is', () => {
    const html = renderGuidePage(guide());
    expect(html).toContain('not medical advice');
    expect(html).toContain('Nothing you enter leaves this page');
    expect(html).toContain('population average');
  });
});
