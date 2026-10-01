/**
 * FocusBro — the hush beds loop without a step.
 *
 * The three hushes are a 30 s noise buffer, looped. The generator is a filter
 * with memory (brown noise is a leaky integrator, pink a bank of them), so its
 * last sample and its first are unrelated values: on the tree before this change
 * the brown bed jumped by roughly its own standard deviation at the wrap — about
 * ten times its largest ordinary sample-to-sample step. Low-pass noise with a
 * step in it is a tick, every 30 seconds, under a sound whose whole job is to be
 * nothing.
 *
 * This runs the app's own noiseBuffer() (lifted from the served HTML) with a
 * fake AudioContext and a seeded Math.random, and checks that the wrap step is
 * an ordinary step. It FAILS on the previous noiseBuffer.
 */

import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

function fnSource(name) {
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

function seededMath(seed) {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(Object.create(Math), { random });
}

function render(colour, seed) {
  const src = fnSource('noiseBuffer');
  expect(src, 'noiseBuffer is missing from the served app').toBeTruthy();
  const sampleRate = 8000;
  const ctx = {
    sampleRate,
    createBuffer(_ch, len) {
      const data = new Float32Array(len);
      return { length: len, getChannelData: () => data };
    },
  };
  const make = new Function('getAudioCtx', 'noiseCache', 'NOISE_SECONDS', 'NOISE_XFADE', 'Math', `${src}; return noiseBuffer;`);
  const noiseBuffer = make(() => ctx, {}, 30, 1, seededMath(seed));
  return noiseBuffer(colour).getChannelData(0);
}

describe('hush beds loop seamlessly', () => {
  for (const colour of ['brown', 'pink', 'white']) {
    it(`${colour}: the wrap is an ordinary step, not a jump`, () => {
      for (const seed of [1, 2, 3]) {
        const d = render(colour, seed);
        const steps = new Float32Array(d.length - 1);
        for (let i = 1; i < d.length; i++) steps[i - 1] = Math.abs(d[i] - d[i - 1]);
        const sorted = Array.from(steps).sort((a, b) => a - b);
        const p999 = sorted[Math.floor(sorted.length * 0.999)];
        const wrap = Math.abs(d[0] - d[d.length - 1]);
        expect(wrap, `${colour} seed ${seed}: wrap step ${wrap.toFixed(4)} vs p99.9 ${p999.toFixed(4)}`).toBeLessThanOrEqual(p999);
      }
    });
  }

  it('the crossfade keeps the level: the head is as loud as the body', () => {
    const d = render('brown', 7);
    const rms = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / (b - a)); };
    const head = rms(0, 8000);                 // the crossfaded first second
    const body = rms(8000, d.length);
    expect(20 * Math.log10(head / body)).toBeGreaterThan(-3);
    expect(20 * Math.log10(head / body)).toBeLessThan(3);
  });
});
