import { describe, it, expect } from 'vitest';
import { returnNudgeCopy } from '../accountability.js';
import { scanDesignLaw } from '../design-law.js';

// The return nudge is the gentle re-entry after days of app silence (Wingspan
// W4 / L3): exactly ONE warm reach-out per dormancy episode, zero agenda, and
// the single most shame-prone moment in the product (the abandoned to-do app's
// "you disappeared"). A person who goes quiet, returns, and goes quiet again
// would otherwise get the IDENTICAL welcome-back each time — the same wallpaper
// decay checkinPromptCopy and escalationCopy already shed one and two rungs down
// the ladder. returnNudgeCopy now rotates across warm, tone-identical variants
// seeded deterministically per dormancy episode (`runReturnNudges` seeds on the
// user id + the `last_event_at` that anchors the episode). This suite pins the
// properties that make that safe: every variant obeys THE DESIGN LAW, never
// names the absence, always holds the door open, the seed is deterministic and
// episode-stable, variant 0 is byte-for-byte the canonical line, and a
// repeat-returner genuinely meets a fresh greeting.

const PERSONAS = ['ally', 'hype', 'unknown'];

function allVariants() {
  const out = [];
  for (const persona of PERSONAS) {
    // 8 seeds is comfortably more than the 4 variants, so every branch is hit.
    for (let seed = 0; seed < 8; seed += 1) out.push(returnNudgeCopy({ persona, seed }));
  }
  return out;
}

describe('returnNudgeCopy rotation — the anti-wallpaper re-entry greeting', () => {
  it('every variant obeys THE DESIGN LAW (never shame, never "AI", never a clinical claim)', () => {
    for (const s of allVariants()) {
      const violations = scanDesignLaw(s);
      expect(violations, `design-LAW violation in: "${s}" → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('every variant is a non-empty string', () => {
    for (const persona of PERSONAS) {
      for (let seed = 0; seed < 8; seed += 1) {
        const s = returnNudgeCopy({ persona, seed });
        expect(typeof s).toBe('string');
        expect(s.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('every variant holds the door open (the "give a word" way in) and names no absence', () => {
    // The LAW is at its sharpest here: the copy must never name the silence, never
    // a streak-at-risk, never a "you missed" — an ally glad they exist, holding
    // the door open. Every variant ends on the same open-door invitation so a
    // returning person always has a way in, no matter which episode they land on.
    for (const persona of ['ally', 'hype']) {
      const variants = [0, 1, 2, 3].map((seed) => returnNudgeCopy({ persona, seed }));
      for (const s of variants) {
        expect(s, `variant missing the open-door way in: "${s}"`).toMatch(/give a word/i);
        // Never names the absence / a lapse — no "back to it", "where you left",
        // "been a while", "gone", "missed". (Warm "pick something back up" is not
        // a lapse framing; these patterns target the absence itself.)
        expect(s, `variant names the absence: "${s}"`).not.toMatch(/been a while|where you left|you disappeared|gone quiet|it'?s been/i);
      }
    }
  });

  it('is deterministic and episode-stable: the same seed always yields the same text', () => {
    for (const persona of PERSONAS) {
      for (const seed of [0, 1, 7, 42, 'u9:2026-07-01T09:00:00.000Z', 999999]) {
        const a = returnNudgeCopy({ persona, seed });
        const b = returnNudgeCopy({ persona, seed });
        expect(b).toBe(a); // one nudge per episode reads consistently within the episode
      }
    }
  });

  it('an absent/empty seed returns the canonical variant 0 (backward compatible)', () => {
    for (const persona of PERSONAS) {
      const canonical = returnNudgeCopy({ persona, seed: 0 });
      expect(returnNudgeCopy({ persona })).toBe(canonical);
      expect(returnNudgeCopy({ persona, seed: undefined })).toBe(canonical);
      expect(returnNudgeCopy({ persona, seed: null })).toBe(canonical);
      expect(returnNudgeCopy({ persona, seed: '' })).toBe(canonical);
    }
    // The canonical wording is exactly the pre-rotation copy — nothing regressed.
    expect(returnNudgeCopy({ persona: 'ally' }))
      .toBe('Hey — no pressure at all, just checking in. I’m still here whenever you want to pick something back up. Want to give a word for today?');
    expect(returnNudgeCopy({ persona: 'hype' }))
      .toBe('Yo — no agenda, just in your corner. 💪 Whenever you want to line something up, I’m right here. Want to give a word for today?');
  });

  it('a repeat-returner rotates: consecutive dormancy episodes are never the identical greeting', () => {
    // runReturnNudges seeds on `${userId}:${last_event_at}`. Model a person who
    // goes quiet, returns, and goes quiet again as a series of increasing
    // last_event_at anchors for the same user id.
    for (const persona of PERSONAS) {
      const series = [];
      for (let day = 1; day <= 12; day += 1) {
        const anchor = `u9:2026-07-${String(day).padStart(2, '0')}T09:00:00.000Z`;
        series.push(returnNudgeCopy({ persona, seed: anchor }));
      }
      for (let i = 1; i < series.length; i += 1) {
        expect(series[i], `back-to-back episodes repeated for ${persona}`).not.toBe(series[i - 1]);
      }
      // And the series genuinely uses more than one variant (not a constant).
      expect(new Set(series).size).toBeGreaterThan(1);
    }
  });

  it('negative and string seeds are safe (never out of range, never throws)', () => {
    for (const seed of [-1, -7, -100, 'x', 'u9:xyz', '👍', 3.9]) {
      const s = returnNudgeCopy({ persona: 'ally', seed });
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('every hype variant carries the 💪 hype marker and no ally variant does (the discriminator)', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      expect(returnNudgeCopy({ persona: 'hype', seed }), `hype variant missing 💪 (seed ${seed})`).toMatch(/💪/);
      expect(returnNudgeCopy({ persona: 'ally', seed }), `ally variant carries 💪 (seed ${seed})`).not.toMatch(/💪/);
    }
  });

  it('proof-of-rejection: a scold in ANY variant slot would be caught by the design-LAW sweep', () => {
    // The rotation does not weaken the gate: accountabilityCopySurface() now
    // sweeps every return-nudge variant, so a crafted shame framing edited into
    // any slot is still rejected by the same scanner. If this ever returned [],
    // the sweep is a no-op.
    expect(scanDesignLaw('You vanished and let yourself down.').length).toBeGreaterThan(0);
  });
});
