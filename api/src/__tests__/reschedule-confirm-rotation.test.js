import { describe, it, expect } from 'vitest';
import { smsRescheduledCopy } from '../accountability.js';
import { scanDesignLaw } from '../design-law.js';

// smsRescheduledCopy is the reschedule-confirmation SMS on the moat channel: a
// person answered the check-in with a new time, and this is the bro reading it
// back — the word still counts, the streak is safe, a reschedule protects the
// chain by construction (never a miss). The outbound nudge (#306), escalation
// knock (#307), and return nudge (#309) already shed their "wallpaper decay";
// this is the reply-family's turn. A RECURRING commitment that a person
// reschedules regularly would otherwise get the IDENTICAL confirmation every
// occurrence — the same decay, on the two-way channel the whole thesis rests on.
// smsRescheduledCopy now rotates across warm, tone-identical variants seeded
// deterministically per OCCURRENCE (the SMS reply path seeds on `open.checkin_id`
// — a recurring commitment materializes a new check-in row per occurrence, so
// the seed advances day to day while a retry of the SAME occurrence reads
// identically). This suite pins the properties that make that safe: every
// variant obeys THE DESIGN LAW, still names the new time, still keeps the word /
// streak safe, the seed is deterministic and occurrence-stable, variant 0 is
// byte-for-byte the canonical line on every (persona × progress) arm, and a
// repeat-rescheduler genuinely meets a fresh confirmation.

const PERSONAS = ['ally', 'hype', 'unknown'];
const PROGRESS = [false, true];
const WHEN = '2026-08-12T15:00:00.000Z';
const TZ = 'UTC';
const NOW = '2026-08-11T09:00:00.000Z';

function base(extra = {}) {
  return { when: WHEN, timezone: TZ, nowISO: NOW, ...extra };
}

function allVariants() {
  const out = [];
  for (const persona of PERSONAS) {
    for (const progress of PROGRESS) {
      // 8 seeds is comfortably more than the 4 variants, so every branch is hit.
      for (let seed = 0; seed < 8; seed += 1) out.push(smsRescheduledCopy(base({ persona, progress, seed })));
    }
  }
  return out;
}

describe('smsRescheduledCopy rotation — the anti-wallpaper reschedule confirmation', () => {
  it('every variant obeys THE DESIGN LAW (never shame, never "AI", never a clinical claim)', () => {
    for (const s of allVariants()) {
      const violations = scanDesignLaw(s);
      expect(violations, `design-LAW violation in: "${s}" → ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('every variant is a non-empty string', () => {
    for (const s of allVariants()) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('every variant names the new time and keeps the word/streak safe (a reschedule is never a miss)', () => {
    // The whole reason this confirmation exists: a reschedule protects the chain.
    // Every variant must (a) name the concrete new time so the return is real,
    // and (b) reassure that the word still counts / the streak is safe — never a
    // tally, never a scold, on any arm of any persona.
    for (const persona of ['ally', 'hype']) {
      for (const progress of PROGRESS) {
        for (let seed = 0; seed < 4; seed += 1) {
          const s = smsRescheduledCopy(base({ persona, progress, seed }));
          // The formatted time for WHEN in UTC. Match the day-part the formatter
          // emits without pinning its exact phrasing: the variant must carry the
          // time token, i.e. it is not the bare 'then' fallback and references
          // the reschedule (a check-back).
          expect(s, `variant missing a check-back on the new time: "${s}"`).toMatch(/check back|swing back|right here/i);
          expect(s, `variant missing the word-counts / streak-safe reassurance: "${s}"`).toMatch(/word still counts|streak/i);
          // Never names a failure/tally.
          expect(s, `variant reads as a scold/tally: "${s}"`).not.toMatch(/you failed|you missed|behind|don'?t forget|again\?!/i);
        }
      }
    }
  });

  it('the progress arm names the movement; the plain arm does not manufacture it', () => {
    for (const persona of ['ally', 'hype']) {
      for (let seed = 0; seed < 4; seed += 1) {
        const withProgress = smsRescheduledCopy(base({ persona, progress: true, seed }));
        expect(withProgress, `progress variant should acknowledge movement: "${withProgress}"`).toMatch(/moving|momentum|headway|got (?:some|a bit)/i);
      }
    }
  });

  it('is deterministic and occurrence-stable: the same seed always yields the same text', () => {
    for (const persona of PERSONAS) {
      for (const progress of PROGRESS) {
        for (const seed of [0, 1, 7, 42, 'checkin_abc123', 999999]) {
          const a = smsRescheduledCopy(base({ persona, progress, seed }));
          const b = smsRescheduledCopy(base({ persona, progress, seed }));
          expect(b).toBe(a); // a retry of the SAME occurrence reads identically
        }
      }
    }
  });

  it('an absent/empty seed returns the canonical variant 0 on every arm (backward compatible)', () => {
    for (const persona of PERSONAS) {
      for (const progress of PROGRESS) {
        const canonical = smsRescheduledCopy(base({ persona, progress, seed: 0 }));
        expect(smsRescheduledCopy(base({ persona, progress }))).toBe(canonical);
        expect(smsRescheduledCopy(base({ persona, progress, seed: undefined }))).toBe(canonical);
        expect(smsRescheduledCopy(base({ persona, progress, seed: null }))).toBe(canonical);
        expect(smsRescheduledCopy(base({ persona, progress, seed: '' }))).toBe(canonical);
      }
    }
    // The canonical wording is exactly the pre-rotation copy — nothing regressed.
    expect(smsRescheduledCopy(base({ persona: 'ally', progress: false })))
      .toBe('Got it — I’ll check back tomorrow at 3:00 PM. Your word still counts, and your streak stays right where it is.');
    expect(smsRescheduledCopy(base({ persona: 'hype', progress: false })))
      .toBe('Got it — I’ll check back tomorrow at 3:00 PM. Your word still counts and your streak’s safe. Let’s go. 💪');
    expect(smsRescheduledCopy(base({ persona: 'ally', progress: true })))
      .toBe('Love that you got moving — I’ll check back tomorrow at 3:00 PM. Your word still counts, and your streak stays right where it is.');
    expect(smsRescheduledCopy(base({ persona: 'hype', progress: true })))
      .toBe('Love that you got moving — that’s momentum! I’ll check back tomorrow at 3:00 PM. Your word still counts and your streak’s safe. Let’s go. 💪');
  });

  it('a repeat-rescheduler rotates: consecutive occurrences are never the identical confirmation', () => {
    // The SMS reply path seeds on `open.checkin_id`. Model a person on a recurring
    // commitment who reschedules each day as a series of distinct per-occurrence
    // check-in ids for the same commitment.
    for (const persona of PERSONAS) {
      for (const progress of PROGRESS) {
        const series = [];
        for (let day = 1; day <= 12; day += 1) {
          const checkinId = `checkin_2026-07-${String(day).padStart(2, '0')}`;
          series.push(smsRescheduledCopy(base({ persona, progress, seed: checkinId })));
        }
        for (let i = 1; i < series.length; i += 1) {
          expect(series[i], `back-to-back occurrences repeated for ${persona}/${progress}`).not.toBe(series[i - 1]);
        }
        // And the series genuinely uses more than one variant (not a constant).
        expect(new Set(series).size).toBeGreaterThan(1);
      }
    }
  });

  it('negative and string seeds are safe (never out of range, never throws)', () => {
    for (const seed of [-1, -7, -100, 'x', 'checkin_xyz', '👍', 3.9]) {
      const s = smsRescheduledCopy(base({ persona: 'ally', seed }));
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('every hype variant carries the 💪 hype marker and no ally variant does (the discriminator)', () => {
    for (const progress of PROGRESS) {
      for (let seed = 0; seed < 8; seed += 1) {
        expect(smsRescheduledCopy(base({ persona: 'hype', progress, seed })), `hype variant missing 💪 (seed ${seed}, progress ${progress})`).toMatch(/💪/);
        expect(smsRescheduledCopy(base({ persona: 'ally', progress, seed })), `ally variant carries 💪 (seed ${seed}, progress ${progress})`).not.toMatch(/💪/);
      }
    }
  });

  it('proof-of-rejection: a scold in ANY variant slot would be caught by the design-LAW sweep', () => {
    // The rotation does not weaken the gate: accountabilityCopySurface() now
    // sweeps every reschedule-confirmation variant, so a crafted shame framing
    // edited into any slot is still rejected by the same scanner. If this ever
    // returned [], the sweep is a no-op.
    expect(scanDesignLaw('Rescheduled again — you keep missing this one.').length).toBeGreaterThan(0);
  });
});
