/**
 * FocusBro — the app's breathing modal, where every breathing guide's CTA lands.
 *
 * It ran 4-7-8 with a fourth hold (fixed in #351), counted every phase one
 * second long (4…0 is five ticks), and animated the circle grow-and-shrink
 * inside a single phase so a "hold with full lungs" showed an empty circle.
 * These run the REAL function extracted from the served app under fake
 * timers with a DOM stub, and pin its counts to the guides' pattern data —
 * one source of truth for what 4-7-8 is. Every case FAILS on the old tree.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import servedHtml from '../html.js';
import { BREATH_PATTERNS } from '../guides/breath-patterns.js';

function fnBody(name) {
  const m = servedHtml.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) return null;
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < servedHtml.length; i++) {
    const c = servedHtml[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return servedHtml.slice(m.index, i + 1);
}
const literal = (name) => new Function(`${servedHtml.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`))[1].replace(/^\{/, 'return {')}`)();

function run(type) {
  const els = { breathingPhaseLabel: {}, breathingTypeDesc: {}, breathingLabel: {}, breathingCircle: { style: {} } };
  const document = { getElementById: (id) => els[id] };
  const start = new Function('document', 'breathingCycles', 'breathingPhaseNames', 'setInterval', 'clearInterval',
    `let breathingTimer = null; ${fnBody('startBreathing')}; return startBreathing;`)(
    document, literal('breathingCycles'), literal('breathingPhaseNames'), setInterval, clearInterval);
  start(type);
  return els;
}

afterEach(() => vi.useRealTimers());

describe('the breathing modal', () => {
  it('runs the same counts as the guides’ pacer — one source of truth for 4-7-8 and box', () => {
    const cycles = literal('breathingCycles');
    const names = literal('breathingPhaseNames');
    expect(cycles['478']).toEqual(BREATH_PATTERNS['478'].phases.map((p) => p.seconds));
    expect(names['478']).toEqual(BREATH_PATTERNS['478'].phases.map((p) => p.name));
    expect(cycles.box).toEqual(BREATH_PATTERNS.box.phases.map((p) => p.seconds));
    expect(names.box).toEqual(BREATH_PATTERNS.box.phases.map((p) => p.name));
  });

  it('counts each phase from its count down to 1 — a 4-7-8 round is 19 ticks, not 22', () => {
    vi.useFakeTimers();
    const els = run('478');
    const seen = [els.breathingLabel.textContent];
    for (let i = 0; i < 21; i++) { vi.advanceTimersByTime(1000); seen.push(els.breathingLabel.textContent); }
    expect(seen.slice(0, 4)).toEqual(['Inhale (4s)', 'Inhale (3s)', 'Inhale (2s)', 'Inhale (1s)']);
    expect(seen[4]).toBe('Hold (7s)');
    expect(seen[11]).toBe('Exhale (8s)');
    expect(seen[18]).toBe('Exhale (1s)');
    expect(seen[19]).toBe('Inhale (4s)');            // the next round starts at tick 19
    expect(seen).not.toContain('Inhale (0s)');
    expect(seen).not.toContain('Hold (0s)');
    expect(els.breathingPhaseLabel.textContent).toBe('4-7-8 Breathing');
  });

  it('fills the circle over an inhale, empties it over an exhale, and holds it in between', () => {
    vi.useFakeTimers();
    const els = run('box');
    const anim = () => els.breathingCircle.style.animation;
    expect(anim()).toBe('breathe-in 4s ease-in-out forwards');
    vi.advanceTimersByTime(4000);                     // hold, full: untouched, so fill-mode keeps it full
    expect(els.breathingLabel.textContent).toBe('Hold (4s)');
    expect(anim()).toBe('breathe-in 4s ease-in-out forwards');
    vi.advanceTimersByTime(4000);
    expect(els.breathingLabel.textContent).toBe('Exhale (4s)');
    expect(anim()).toBe('breathe-out 4s ease-in-out forwards');
    vi.advanceTimersByTime(4000);                     // hold, empty
    expect(anim()).toBe('breathe-out 4s ease-in-out forwards');
    expect(servedHtml).toContain('@keyframes breathe-in');
    expect(servedHtml).toContain('@keyframes breathe-out');
    expect(servedHtml).not.toContain('animation: breathing 8s ease-in-out infinite');
    expect(servedHtml).toContain('.breathing-circle { animation: none !important; }');
  });

  it('names tactical breathing as itself, not as box', () => {
    vi.useFakeTimers();
    expect(run('tactical').breathingPhaseLabel.textContent).toBe('Tactical Breathing');
    expect(run('nope').breathingPhaseLabel.textContent).toBe('Box Breathing');
  });
});
