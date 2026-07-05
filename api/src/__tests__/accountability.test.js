/**
 * FocusBro — Accountability Core tests (Contender track, issue #10, Phase A)
 * Covers the pure engine (validation, kept-word streak transitions) and,
 * critically, the ONE design LAW: never shame. The copy-law test below is the
 * automated guardrail that keeps a guilt engine from ever shipping.
 */

import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  PERSONAS,
  OUTCOMES,
  pickPersona,
  validateCommitmentInput,
  computeStreakAfter,
  checkinPromptCopy,
  keptCopy,
  missRescheduleCopy,
  rescheduleConfirmCopy,
  streakSummaryCopy,
} from '../accountability.js';

describe('validateCommitmentInput', () => {
  const validBody = { title: 'Start the taxes', start_at: '2026-07-05T14:00:00Z' };

  it('accepts a minimal valid commitment and defaults the check-in ~1h after start', () => {
    const r = validateCommitmentInput(validBody);
    expect(r.ok).toBe(true);
    expect(r.value.title).toBe('Start the taxes');
    expect(r.value.channel).toBe('push');
    expect(r.value.persona).toBe('ally');
    // check-in defaults to start + 60m
    expect(new Date(r.value.checkinAt).getTime() - new Date(r.value.startAt).getTime()).toBe(60 * 60 * 1000);
  });

  it('rejects a missing/blank title', () => {
    expect(validateCommitmentInput({ start_at: validBody.start_at }).ok).toBe(false);
    expect(validateCommitmentInput({ title: '   ', start_at: validBody.start_at }).ok).toBe(false);
  });

  it('rejects an invalid or missing start time', () => {
    expect(validateCommitmentInput({ title: 'x' }).ok).toBe(false);
    expect(validateCommitmentInput({ title: 'x', start_at: 'not-a-date' }).ok).toBe(false);
  });

  it('rejects the voice channel with a warm, forward-looking message (Phase B gate)', () => {
    const r = validateCommitmentInput({ ...validBody, channel: 'voice' });
    expect(r.ok).toBe(false);
    expect(r.error.toLowerCase()).toContain('coming soon');
  });

  it('rejects an unknown channel', () => {
    expect(validateCommitmentInput({ ...validBody, channel: 'carrier-pigeon' }).ok).toBe(false);
  });

  it('honors an explicit check-in time, persona, and channel', () => {
    const r = validateCommitmentInput({
      title: 'Write the report',
      start_at: '2026-07-05T09:00:00Z',
      checkin_at: '2026-07-05T11:30:00Z',
      channel: 'text',
      persona: 'hype',
    });
    expect(r.ok).toBe(true);
    expect(r.value.channel).toBe('text');
    expect(r.value.persona).toBe('hype');
    expect(r.value.checkinAt).toBe('2026-07-05T11:30:00.000Z');
  });
});

describe('pickPersona', () => {
  it('defaults unknown personas to the calm ally', () => {
    expect(pickPersona('ally')).toBe('ally');
    expect(pickPersona('hype')).toBe('hype');
    expect(pickPersona('drill-sergeant')).toBe('ally');
    expect(pickPersona(undefined)).toBe('ally');
  });
});

describe('computeStreakAfter — kept-word streak (no miss tally, by design)', () => {
  const zero = { current_streak: 0, longest_streak: 0, total_kept: 0, last_kept_date: null };

  it('increments current + total and tracks longest on a kept word', () => {
    const s1 = computeStreakAfter(zero, 'kept', '2026-07-05');
    expect(s1.current_streak).toBe(1);
    expect(s1.total_kept).toBe(1);
    expect(s1.longest_streak).toBe(1);
    expect(s1.last_kept_date).toBe('2026-07-05');
    const s2 = computeStreakAfter(s1, 'kept', '2026-07-06');
    expect(s2.current_streak).toBe(2);
    expect(s2.longest_streak).toBe(2);
  });

  it('PROTECTS the streak on a reschedule (the no-shame path never breaks the chain)', () => {
    const s = { current_streak: 4, longest_streak: 7, total_kept: 10, last_kept_date: '2026-07-01' };
    const after = computeStreakAfter(s, 'reschedule', '2026-07-05');
    expect(after.current_streak).toBe(4);
    expect(after.longest_streak).toBe(7);
    expect(after.total_kept).toBe(10);
  });

  it('silently resets current to 0 on a miss, preserves longest, and keeps NO miss counter', () => {
    const s = { current_streak: 5, longest_streak: 9, total_kept: 12, last_kept_date: '2026-07-04' };
    const after = computeStreakAfter(s, 'missed', '2026-07-05');
    expect(after.current_streak).toBe(0);
    expect(after.longest_streak).toBe(9); // best is never taken away
    // the object exposes exactly these four keys — no miss/failure tally exists
    expect(Object.keys(after).sort()).toEqual(
      ['current_streak', 'last_kept_date', 'longest_streak', 'total_kept'].sort()
    );
  });

  it('handles empty/garbage prior state without throwing', () => {
    expect(computeStreakAfter(null, 'kept', '2026-07-05').current_streak).toBe(1);
    expect(computeStreakAfter({}, 'missed', '2026-07-05').current_streak).toBe(0);
  });
});

// ── THE DESIGN LAW: never shame ──────────────────────────────
// Every string this product can say to a user must be an ally, never a boss
// tallying misses. This test renders every copy function across every persona
// and a spread of streak states, and fails the build if any output contains a
// shaming word, the banned "AI" branding, or a clinical/treatment claim.
describe('copy law — never shame, never "AI", never a clinical claim', () => {
  const SHAME_PATTERNS = [
    /\bfail(ed|ure|ing|s)?\b/i,
    /\blaz(y|iness)\b/i,
    /\bdisappoint/i,
    /\bguilt/i,
    /\bashamed\b/i,
    /\bshame\b/i,
    /\byou (didn.?t|should have|should.?ve)\b/i,
    /\bfall(ing|en)? behind\b/i,
    /\bbehind again\b/i,
    /\bexcuse/i,
    /\bslack(ing|er|ed)? off\b/i,
    /\bpathetic\b/i,
    /\bworthless\b/i,
    /\bagain\?!\b/i,
  ];
  const CLINICAL_PATTERNS = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
  const AI_WORD = /\bAI\b/; // case-sensitive: the banned branding, not "again"/"said"

  // A representative spread of inputs, both personas, edge streak values.
  const samples = [];
  for (const persona of ['ally', 'hype', 'unknown']) {
    samples.push(checkinPromptCopy({ title: 'call the dentist', persona }));
    samples.push(checkinPromptCopy({ persona })); // no title → generic
    for (const streak of [0, 1, 2, 25]) {
      samples.push(keptCopy({ persona, streak }));
    }
    samples.push(missRescheduleCopy({ persona }));
    samples.push(rescheduleConfirmCopy({ persona, when: '2026-07-05T15:00:00Z' }));
    samples.push(rescheduleConfirmCopy({ persona })); // no time
    samples.push(streakSummaryCopy({ persona, streak: { current_streak: 0, longest_streak: 3 } }));
    samples.push(streakSummaryCopy({ persona, streak: { current_streak: 1, longest_streak: 1 } }));
    samples.push(streakSummaryCopy({ persona, streak: { current_streak: 6, longest_streak: 9 } }));
  }

  it('produces non-empty strings for every copy path', () => {
    for (const s of samples) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('never emits a shaming word', () => {
    for (const s of samples) {
      for (const pat of SHAME_PATTERNS) {
        expect(pat.test(s), `shaming copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('never emits the word "AI" in user-facing copy', () => {
    for (const s of samples) {
      expect(AI_WORD.test(s), `"AI" leaked into copy: "${s}"`).toBe(false);
    }
  });

  it('never makes a clinical or treatment claim', () => {
    for (const s of samples) {
      for (const pat of CLINICAL_PATTERNS) {
        expect(pat.test(s), `clinical claim in copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('a miss always leaves the door open (offers to try again, never a dead end)', () => {
    for (const persona of ['ally', 'hype']) {
      const miss = missRescheduleCopy({ persona }).toLowerCase();
      expect(miss).toMatch(/try again|new time|when (works|do you)/);
    }
  });

  it('a zero streak reads as a fresh start, not a broken one', () => {
    for (const persona of ['ally', 'hype']) {
      const s = streakSummaryCopy({ persona, streak: { current_streak: 0, longest_streak: 4 } }).toLowerCase();
      expect(s).toContain('fresh start');
    }
  });
});

describe('module constants', () => {
  it('exposes the Phase A channel/persona/outcome vocabularies', () => {
    expect(CHANNELS).toEqual(['push', 'text']); // voice is Phase B
    expect(PERSONAS).toEqual(['ally', 'hype']);
    expect(OUTCOMES).toEqual(['kept', 'missed', 'reschedule']);
  });
});
