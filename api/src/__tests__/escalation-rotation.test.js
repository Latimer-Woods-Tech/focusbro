import { describe, it, expect } from 'vitest';
import { escalationCopy } from '../accountability.js';
import { scanDesignLaw } from '../design-law.js';

// The escalation knock is the ONE warm SMS follow-up after a delivered push has
// gone quiet (Wingspan W1, push → SMS, exactly once). A recurring commitment
// that goes quiet each day would otherwise fire the IDENTICAL escalation text
// every time — the same wallpaper decay checkinPromptCopy already fixed one rung
// up the ladder. escalationCopy now rotates across warm, tone-identical variants
// seeded deterministically by the per-occurrence check-in id. This suite pins the
// properties that make that safe: every variant obeys THE DESIGN LAW, still
// offers BOTH the tiny-step and the warm exit, the seed is deterministic and
// retry-stable, and a recurring series actually varies.

const PERSONAS = ['ally', 'hype', 'unknown'];
const TITLES = ['start the taxes', 'call the dentist', 'the thing', undefined];

function allVariants() {
  const out = [];
  for (const persona of PERSONAS) {
    for (const title of TITLES) {
      // 8 seeds is comfortably more than the 4 variants, so every branch is hit.
      for (let seed = 0; seed < 8; seed += 1) {
        out.push(escalationCopy({ title, persona, seed }));
      }
    }
  }
  return out;
}

describe('escalationCopy rotation — the anti-wallpaper knock', () => {
  it('every variant obeys THE DESIGN LAW (never shame, never "AI", never a clinical claim)', () => {
    for (const s of allVariants()) {
      const violations = scanDesignLaw(s);
      expect(violations, `design-LAW violation in: "${s}" → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('every variant is a non-empty string that names the word', () => {
    for (const persona of PERSONAS) {
      for (let seed = 0; seed < 8; seed += 1) {
        const s = escalationCopy({ title: 'start the taxes', persona, seed });
        expect(typeof s).toBe('string');
        expect(s.trim().length).toBeGreaterThan(0);
        expect(s).toMatch(/the taxes/);
      }
    }
  });

  it('every variant offers a way in, and the warm exit recurs through the rotation (never a one-way push to start)', () => {
    // The escalation must never read as a one-way push to start — a person who
    // needs to defer has to feel just as welcome. Every variant carries a
    // start-small way in; the "pick a better time" exit recurs across the
    // rotation (the preserved canonical hype line leads with the step, so the
    // exit is offered in the other variants a recurring miss will also see).
    for (const persona of ['ally', 'hype']) {
      const variants = [0, 1, 2, 3].map((seed) => escalationCopy({ title: 'start the taxes', persona, seed }));
      for (const s of variants) {
        expect(s, `variant missing the start-small way in: "${s}"`)
          .toMatch(/small|tiny|little|step|piece|start/i);
      }
      const withExit = variants.filter((s) => /better time|time that (fits|works) better/i.test(s));
      expect(withExit.length, `warm exit should recur across the ${persona} rotation`).toBeGreaterThanOrEqual(3);
    }
  });

  it('is deterministic and retry-stable: the same seed always yields the same text', () => {
    for (const persona of PERSONAS) {
      for (const seed of [0, 1, 7, 42, 'ci_abc', 999999]) {
        const a = escalationCopy({ title: 'start the taxes', persona, seed });
        const b = escalationCopy({ title: 'start the taxes', persona, seed });
        expect(b).toBe(a); // a redelivered/retried occurrence reads identically
      }
    }
  });

  it('an absent/empty seed returns the canonical variant 0 (backward compatible)', () => {
    for (const persona of PERSONAS) {
      const canonical = escalationCopy({ title: 'start the taxes', persona, seed: 0 });
      expect(escalationCopy({ title: 'start the taxes', persona })).toBe(canonical);
      expect(escalationCopy({ title: 'start the taxes', persona, seed: undefined })).toBe(canonical);
      expect(escalationCopy({ title: 'start the taxes', persona, seed: null })).toBe(canonical);
      expect(escalationCopy({ title: 'start the taxes', persona, seed: '' })).toBe(canonical);
    }
    // The canonical wording is exactly the pre-rotation copy — nothing regressed.
    expect(escalationCopy({ title: 'start the taxes', persona: 'ally' }))
      .toBe('No rush — I’m still here about start the taxes. Want to start small together, or pick a better time?');
    expect(escalationCopy({ title: 'start the taxes', persona: 'hype' }))
      .toBe('Still right here — start the taxes is ready when you are. One tiny step together? 🔥');
  });

  it('a recurring series rotates: consecutive occurrences are never the identical knock', () => {
    for (const persona of PERSONAS) {
      // Model a daily recurring commitment as monotonically increasing check-in ids.
      const series = [];
      for (let checkinId = 100; checkinId < 112; checkinId += 1) {
        series.push(escalationCopy({ title: 'call the dentist', persona, seed: checkinId }));
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
      const s = escalationCopy({ title: 'the thing', persona: 'ally', seed });
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('every hype variant carries an unmistakable hype marker (Yo / 🔥) — the coach-delivery contract', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      const s = escalationCopy({ title: 'start the taxes', persona: 'hype', seed });
      expect(s, `hype variant missing marker: "${s}"`).toMatch(/🔥|Yo/);
    }
  });

  it('proof-of-rejection: a scold in ANY variant slot would be caught by the design-LAW sweep', () => {
    // The rotation does not weaken the gate: a crafted shame framing is still
    // rejected by the same scanner that sweeps every variant in
    // accountabilityCopySurface(). If this ever returned [], the sweep is a no-op.
    expect(scanDesignLaw("You flaked again — don't waste my time.").length).toBeGreaterThan(0);
  });
});
