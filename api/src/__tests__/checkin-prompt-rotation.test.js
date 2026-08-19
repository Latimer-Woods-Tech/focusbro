import { describe, it, expect } from 'vitest';
import { checkinPromptCopy } from '../accountability.js';
import { scanDesignLaw } from '../design-law.js';

// The outbound check-in nudge is the OTHER half of the two-way text moat. A
// recurring commitment fires it on every occurrence, so a single fixed line
// reads as the same wallpaper text every day — which an ADHD brain filters out,
// the exact decay that turns a nudge into a swipe-away. checkinPromptCopy now
// rotates across warm, tone-identical variants, seeded deterministically by the
// per-occurrence check-in id. This suite pins the three properties that make
// that safe: every variant obeys THE DESIGN LAW, the seed is deterministic and
// retry-stable, and a recurring series actually varies.

const PERSONAS = ['ally', 'hype', 'unknown'];
const TITLES = ['start the taxes', 'call the dentist', 'the thing', undefined];

// Enumerate the full variant set the function can emit, across personas/titles.
function allVariants() {
  const out = [];
  for (const persona of PERSONAS) {
    for (const title of TITLES) {
      // 8 seeds is comfortably more than the 4 variants, so every branch is hit.
      for (let seed = 0; seed < 8; seed += 1) {
        out.push(checkinPromptCopy({ title, persona, seed }));
      }
    }
  }
  return out;
}

describe('checkinPromptCopy rotation — the anti-wallpaper nudge', () => {
  it('every variant obeys THE DESIGN LAW (never shame, never "AI", never a clinical claim)', () => {
    for (const s of allVariants()) {
      const violations = scanDesignLaw(s);
      expect(violations, `design-LAW violation in: "${s}" → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('every variant is a non-empty string that names the word', () => {
    for (const persona of PERSONAS) {
      for (let seed = 0; seed < 8; seed += 1) {
        const s = checkinPromptCopy({ title: 'start the taxes', persona, seed });
        expect(typeof s).toBe('string');
        expect(s.trim().length).toBeGreaterThan(0);
        expect(s).toMatch(/the taxes/);
      }
    }
  });

  it('is deterministic and retry-stable: the same seed always yields the same text', () => {
    for (const persona of PERSONAS) {
      for (const seed of [0, 1, 7, 42, 'ci_abc', 999999]) {
        const a = checkinPromptCopy({ title: 'start the taxes', persona, seed });
        const b = checkinPromptCopy({ title: 'start the taxes', persona, seed });
        expect(b).toBe(a); // a redelivered/retried occurrence reads identically
      }
    }
  });

  it('an absent/empty seed returns the canonical variant 0 (backward compatible)', () => {
    for (const persona of PERSONAS) {
      const canonical = checkinPromptCopy({ title: 'start the taxes', persona, seed: 0 });
      expect(checkinPromptCopy({ title: 'start the taxes', persona })).toBe(canonical);
      expect(checkinPromptCopy({ title: 'start the taxes', persona, seed: undefined })).toBe(canonical);
      expect(checkinPromptCopy({ title: 'start the taxes', persona, seed: null })).toBe(canonical);
      expect(checkinPromptCopy({ title: 'start the taxes', persona, seed: '' })).toBe(canonical);
    }
    // The ally canonical is exactly the pre-rotation wording — nothing regressed.
    expect(checkinPromptCopy({ title: 'start the taxes', persona: 'ally' }))
      .toBe('You said you’d start the taxes. I’m here — ready to go? We’ve got this.');
  });

  it('a recurring series rotates: consecutive occurrences are never the identical line', () => {
    for (const persona of PERSONAS) {
      // Model a daily recurring commitment as monotonically increasing check-in ids.
      const series = [];
      for (let checkinId = 100; checkinId < 112; checkinId += 1) {
        series.push(checkinPromptCopy({ title: 'call the dentist', persona, seed: checkinId }));
      }
      for (let i = 1; i < series.length; i += 1) {
        expect(series[i], `back-to-back occurrences repeated for ${persona}`).not.toBe(series[i - 1]);
      }
      // And the series genuinely uses more than one variant (not a constant).
      expect(new Set(series).size).toBeGreaterThan(1);
    }
  });

  it('negative and string seeds are safe (never out of range, never throws)', () => {
    for (const seed of [-1, -7, -100, 'x', 'ci_09fA', '👍', 3.9]) {
      const s = checkinPromptCopy({ title: 'the thing', persona: 'ally', seed });
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('every hype variant carries an unmistakable hype marker (Yo / 🔥) — the coach-delivery contract', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      const s = checkinPromptCopy({ title: 'start the taxes', persona: 'hype', seed });
      expect(s, `hype variant missing marker: "${s}"`).toMatch(/🔥|Yo/);
    }
  });

  it('reads a non-verb title with a "do" prefix, a verb title bare (grammar holds across variants)', () => {
    // Non-verb noun phrase → "do the taxes"; verb-led → left bare.
    const noun = [];
    const verb = [];
    for (let seed = 0; seed < 8; seed += 1) {
      noun.push(checkinPromptCopy({ title: 'the taxes', persona: 'ally', seed }));
      verb.push(checkinPromptCopy({ title: 'call the dentist', persona: 'ally', seed }));
    }
    // At least one rotated variant exercises the "do "-prefixed object form.
    expect(noun.some((s) => /do the taxes/.test(s))).toBe(true);
    // A verb-led title is never double-prefixed with "do call".
    for (const s of verb) expect(s).not.toMatch(/do call the dentist/);
  });
});
