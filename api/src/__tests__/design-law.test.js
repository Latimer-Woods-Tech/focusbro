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
import { accountabilityCopySurface } from '../accountability.js';

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
  // The bro's actual voice — the nudge/escalation/return copy + two-way SMS
  // replies that land on a person's phone. Highest-stakes anti-shame surface;
  // consumer voice, so bare ADHD is banned here the same as the other consumer
  // surfaces.
  { label: 'accountabilityCopySurface', strings: accountabilityCopySurface(), allowAdhd: false },
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

/**
 * Proof-of-rejection for the newly-swept accountability surface (Standing Law #1):
 * the sweep is only real if it would FAIL on a shame leak in the bro's voice. We
 * can't mutate the frozen copy engine, so we prove the guard the sweep relies on
 * rejects a representative outbound violation, and that the real surface is broad
 * enough that the sweep isn't vacuously passing on a near-empty list.
 */
describe('accountabilityCopySurface — the bro voice is swept and the sweep bites', () => {
  it('enumerates a broad surface (both personas × every confirmation arm), not a stub', () => {
    const strings = accountabilityCopySurface();
    expect(Array.isArray(strings)).toBe(true);
    // Both personas × the full copy family → well over the dashboard surfaces.
    expect(strings.length).toBeGreaterThan(40);
    expect(strings.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('the sweep would catch a shame / "AI" leak in an outbound nudge', () => {
    // A hand-authored counterfeit of a check-in nudge that violates the law —
    // exactly the class of edit the sweep exists to stop reaching a phone.
    const shamingNudge = 'You missed the taxes again — you keep failing your streak.';
    const aiBrandedNudge = 'Your AI coach is checking in about the taxes.';
    expect(() => assertDesignLawClean([shamingNudge], { label: 'accountabilityCopySurface' })).toThrow(/shame/);
    expect(() => assertDesignLawClean([aiBrandedNudge], { label: 'accountabilityCopySurface' })).toThrow(/ai-branding/);
    // And the real surface, swept at the same bar, is clean.
    expect(() =>
      assertDesignLawClean(accountabilityCopySurface(), { allowAdhd: false, label: 'accountabilityCopySurface' }),
    ).not.toThrow();
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

  // Proof-of-rejection (Standing Law #1) for the consolidation done this run:
  // every consumer/coach copy-surface test now derives its clinical guard from
  // `[...TREATMENT_CLAIM_PATTERNS, ADHD_WORD]` instead of a hand-rolled list.
  // The old hand-rolled lists had drifted — several omitted `therapy`, so a
  // valid-but-clinical string like "a form of therapy" slipped past them. This
  // pins the composed shape those surfaces now share: it MUST catch `therapy`
  // (the word the drift dropped) and `medication` from the frozen source, and
  // the consumer `ADHD` ban, while staying clean on warm copy. If a future edit
  // drops `therapy` from the canonical list, every consolidated surface loses it
  // at once — and this test goes red first.
  it('the composed consumer clinical guard rejects therapy/medication/ADHD, not warm copy', () => {
    const guard = [...TREATMENT_CLAIM_PATTERNS, ADHD_WORD];
    const hit = (s) => guard.some((p) => p.test(s));
    for (const bad of ['a form of therapy', 'adjust your medication', 'built for ADHD brains']) {
      expect(hit(bad), `expected a clinical hit in: ${bad}`).toBe(true);
    }
    for (const ok of ['no problem — when do you want to try again?', 'ready when you are']) {
      expect(hit(ok), `unexpected clinical hit in: ${ok}`).toBe(false);
    }
  });
});
