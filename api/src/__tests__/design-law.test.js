import { describe, it, expect } from 'vitest';
import {
  scanDesignLaw,
  assertDesignLawClean,
  SHAME_PATTERNS,
  TREATMENT_CLAIM_PATTERNS,
  AI_BRANDING,
  ADHD_WORD,
} from '../design-law.js';
import { meCopySurface } from '../me.js';
import { roomCopySurface } from '../room.js';
import { consentCopySurface } from '../consent.js';
import { coachOnboardingCopySurface } from '../coach-onboarding.js';
import { coachOperatorRosterCopySurface } from '../coach-operator-roster.js';

/**
 * THE DESIGN LAW, enforced once for every user-facing copy surface.
 *
 * Before this file each surface carried its own hand-rolled banned-word list, and
 * they had drifted: the two coach surfaces never checked for banned "AI" branding
 * or clinical claims. This sweeps every surface through the single `scanDesignLaw`
 * source of truth so the bar is identical everywhere.
 *
 * `allowAdhd` marks the coach-pitch surfaces where naming ADHD is permitted
 * (guardrail: "ADHD lives in SEO and the coach pitch, not in a clinical promise").
 * Consumer surfaces ban it.
 */
const SURFACES = [
  { label: 'meCopySurface', strings: meCopySurface(), allowAdhd: false },
  { label: 'roomCopySurface', strings: roomCopySurface(), allowAdhd: false },
  { label: 'consentCopySurface', strings: consentCopySurface(), allowAdhd: false },
  // Coach-facing pitch/onboarding + operator roster: ADHD may be named in the
  // pitch, but shame / treatment claims / "AI" are banned the same as anywhere.
  { label: 'coachOnboardingCopySurface', strings: coachOnboardingCopySurface(), allowAdhd: true },
  { label: 'coachOperatorRosterCopySurface', strings: coachOperatorRosterCopySurface(), allowAdhd: true },
];

describe('THE DESIGN LAW — every copy surface, one source of truth', () => {
  for (const { label, strings, allowAdhd } of SURFACES) {
    it(`${label} is design-LAW clean (no shame / treatment claim / "AI"${allowAdhd ? '' : ' / bare ADHD'})`, () => {
      expect(Array.isArray(strings) || typeof strings[Symbol.iterator] === 'function').toBe(true);
      let count = 0;
      for (const raw of strings) {
        count += 1;
        const violations = scanDesignLaw(raw, { allowAdhd });
        expect(
          violations,
          violations.length
            ? `${label}: ${JSON.stringify(String(raw))} → ${violations.map((v) => `${v.kind}(${v.pattern})`).join(', ')}`
            : '',
        ).toEqual([]);
      }
      // Guard against an empty/stubbed surface silently "passing".
      expect(count, `${label} returned no strings`).toBeGreaterThan(0);
    });
  }

  it('assertDesignLawClean accepts every surface at its declared ADHD policy', () => {
    for (const { label, strings, allowAdhd } of SURFACES) {
      expect(() => assertDesignLawClean(strings, { allowAdhd, label })).not.toThrow();
    }
  });
});

/**
 * Proof-of-rejection (Factory Standing Law #1): a guard that has never rejected
 * anything is presumed broken. These pin that the scanner actually FAILS on real
 * violations — if someone loosens the lexicon, one of these goes red.
 */
describe('scanDesignLaw — proof it rejects real violations', () => {
  it('flags shame / self-blame copy', () => {
    for (const bad of [
      'You failed to keep your word again.',
      "You're falling behind.",
      "Don't be lazy about it.",
      'That was a pathetic excuse.',
      'You missed three check-ins.',
      "You should have started by now.",
      'The client went unresponsive.',
    ]) {
      const v = scanDesignLaw(bad);
      expect(v.some((x) => x.kind === 'shame'), `expected shame in: ${bad}`).toBe(true);
    }
  });

  it('flags clinical / treatment claims on any surface, coach copy included', () => {
    for (const bad of [
      'We treat ADHD.',
      'A cure for your focus problems.',
      'Get a diagnosis here.',
      'Manages your disorder and symptoms.',
      'Adjust your medication.',
      'A form of therapy.',
    ]) {
      const v = scanDesignLaw(bad, { allowAdhd: true }); // even where ADHD is allowed
      expect(v.some((x) => x.kind === 'treatment'), `expected treatment claim in: ${bad}`).toBe(true);
    }
  });

  it('flags bare "AI" branding, case-sensitively', () => {
    expect(scanDesignLaw('Meet your AI coach.').some((v) => v.kind === 'ai-branding')).toBe(true);
    // ordinary words that merely contain the letters are NOT violations
    for (const ok of ['See you again soon.', 'You said you would.', 'Check your email.', 'The detail matters.']) {
      expect(scanDesignLaw(ok).some((v) => v.kind === 'ai-branding'), `false positive in: ${ok}`).toBe(false);
    }
  });

  it('bans bare "ADHD" in consumer copy but allows it in the coach pitch', () => {
    const s = 'Built for ADHD brains.';
    expect(scanDesignLaw(s).some((v) => v.kind === 'adhd-in-consumer-copy')).toBe(true);
    expect(scanDesignLaw(s, { allowAdhd: true }).some((v) => v.kind === 'adhd-in-consumer-copy')).toBe(false);
  });

  it('does not false-positive on warm, on-brand copy', () => {
    for (const ok of [
      'No problem — when do you want to try again?',
      'You said, I’m here, let’s go.',
      'Be patient with yourself; plans change.',
      'Ready when you are.',
      'One word at a time.',
    ]) {
      expect(scanDesignLaw(ok), `unexpected violation in: ${ok}`).toEqual([]);
    }
  });
});

describe('design-law lexicon shape', () => {
  it('exposes frozen pattern lists so the source of truth cannot be mutated at runtime', () => {
    expect(Object.isFrozen(SHAME_PATTERNS)).toBe(true);
    expect(Object.isFrozen(TREATMENT_CLAIM_PATTERNS)).toBe(true);
    expect(SHAME_PATTERNS.length).toBeGreaterThan(10);
    expect(TREATMENT_CLAIM_PATTERNS.length).toBeGreaterThan(4);
    expect(AI_BRANDING).toBeInstanceOf(RegExp);
    expect(ADHD_WORD).toBeInstanceOf(RegExp);
  });
});
