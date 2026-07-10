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
  RECURRENCES,
  pickPersona,
  pickRecurrence,
  parseLocalTime,
  nextOccurrenceISO,
  localTimeFromISO,
  validateCommitmentInput,
  computeStreakAfter,
  checkinPromptCopy,
  keptCopy,
  missRescheduleCopy,
  rescheduleConfirmCopy,
  releaseConfirmCopy,
  pauseConfirmCopy,
  resumeConfirmCopy,
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

describe('recurring cadence — pickRecurrence / parseLocalTime', () => {
  it('normalizes unknown cadences to a one-shot', () => {
    expect(RECURRENCES).toContain('daily');
    expect(RECURRENCES).toContain('weekdays');
    expect(pickRecurrence('daily')).toBe('daily');
    expect(pickRecurrence('weekdays')).toBe('weekdays');
    expect(pickRecurrence('hourly')).toBe('none');
    expect(pickRecurrence(undefined)).toBe('none');
  });

  it('parses valid HH:MM and rejects junk', () => {
    expect(parseLocalTime('08:40')).toEqual({ h: 8, m: 40 });
    expect(parseLocalTime('23:59')).toEqual({ h: 23, m: 59 });
    expect(parseLocalTime('9:05')).toEqual({ h: 9, m: 5 });
    expect(parseLocalTime('24:00')).toBeNull();
    expect(parseLocalTime('08:60')).toBeNull();
    expect(parseLocalTime('not-a-time')).toBeNull();
    expect(parseLocalTime(undefined)).toBeNull();
  });
});

describe('nextOccurrenceISO — DST-correct daily / weekday cadence', () => {
  it('returns null for a one-shot or unusable input', () => {
    expect(nextOccurrenceISO({ recurrence: 'none', timezone: 'UTC', localTime: '08:40', afterISO: '2026-07-06T00:00:00Z' })).toBeNull();
    expect(nextOccurrenceISO({ recurrence: 'daily', timezone: 'UTC', localTime: 'bad', afterISO: '2026-07-06T00:00:00Z' })).toBeNull();
    expect(nextOccurrenceISO({ recurrence: 'daily', timezone: 'UTC', localTime: '08:40', afterISO: 'not-a-date' })).toBeNull();
  });

  it('picks today when the local time is still ahead, tomorrow once it has passed', () => {
    // 08:40 America/New_York = 12:40Z in summer (EDT, UTC-4).
    const before = nextOccurrenceISO({ recurrence: 'daily', timezone: 'America/New_York', localTime: '08:40', afterISO: '2026-07-06T10:00:00Z' });
    expect(before).toBe('2026-07-06T12:40:00.000Z');
    const after = nextOccurrenceISO({ recurrence: 'daily', timezone: 'America/New_York', localTime: '08:40', afterISO: '2026-07-06T13:00:00Z' });
    expect(after).toBe('2026-07-07T12:40:00.000Z');
  });

  it('holds the local wall-clock time across a US DST spring-forward (offset shifts, 08:40 local stays 08:40)', () => {
    // 2026 US DST begins Sun Mar 8. Before: EST (UTC-5) → 08:40 local = 13:40Z.
    const est = nextOccurrenceISO({ recurrence: 'daily', timezone: 'America/New_York', localTime: '08:40', afterISO: '2026-03-06T20:00:00Z' });
    expect(est).toBe('2026-03-07T13:40:00.000Z');
    // After the transition: EDT (UTC-4) → 08:40 local = 12:40Z (one hour earlier in UTC, same wall time).
    const edt = nextOccurrenceISO({ recurrence: 'daily', timezone: 'America/New_York', localTime: '08:40', afterISO: '2026-03-09T20:00:00Z' });
    expect(edt).toBe('2026-03-10T12:40:00.000Z');
  });

  it('skips Saturday and Sunday for the weekdays cadence', () => {
    // 2026-07-10 is a Friday; next weekday occurrence after Fri 09:00 local is Monday.
    const fri = nextOccurrenceISO({ recurrence: 'weekdays', timezone: 'UTC', localTime: '09:00', afterISO: '2026-07-10T12:00:00Z' });
    expect(fri).toBe('2026-07-13T09:00:00.000Z'); // Monday, skipping Sat 11 + Sun 12
    // Daily would instead land on Saturday the 11th.
    const daily = nextOccurrenceISO({ recurrence: 'daily', timezone: 'UTC', localTime: '09:00', afterISO: '2026-07-10T12:00:00Z' });
    expect(daily).toBe('2026-07-11T09:00:00.000Z');
  });

  it('round-trips a local-time anchor via localTimeFromISO', () => {
    expect(localTimeFromISO('2026-07-06T12:40:00.000Z', 'America/New_York')).toBe('08:40');
    expect(localTimeFromISO('2026-07-06T12:40:00.000Z', 'UTC')).toBe('12:40');
  });
});

describe('validateCommitmentInput — recurring commitments', () => {
  const NOW = '2026-07-06T10:00:00Z';

  it('derives the first check-in from a local-time anchor when no start_at is given', () => {
    const r = validateCommitmentInput(
      { title: 'send one outreach item', recurrence: 'daily', local_time: '08:40', timezone: 'America/New_York' },
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.value.recurrence).toBe('daily');
    expect(r.value.localTime).toBe('08:40');
    // 08:40 ET is still ahead of 10:00Z (06:00 ET), so it schedules today.
    expect(r.value.startAt).toBe('2026-07-06T12:40:00.000Z');
    // A recurring check-in fires at the moment itself — no +1h default.
    expect(r.value.checkinAt).toBe(r.value.startAt);
  });

  it('rejects a recurring commitment with neither a start_at nor a local time', () => {
    const r = validateCommitmentInput({ title: 'x', recurrence: 'daily' }, NOW);
    expect(r.ok).toBe(false);
    expect(r.error.toLowerCase()).toContain('daily or weekdays');
  });

  it('derives the local-time anchor from an explicit start_at for a recurring commitment', () => {
    const r = validateCommitmentInput(
      { title: 'stretch', recurrence: 'weekdays', start_at: '2026-07-06T13:00:00Z', timezone: 'UTC' },
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.value.localTime).toBe('13:00');
  });

  it('leaves a one-shot commitment unchanged (no recurrence, empty local time, +1h check-in)', () => {
    const r = validateCommitmentInput({ title: 'taxes', start_at: '2026-07-06T14:00:00Z' }, NOW);
    expect(r.ok).toBe(true);
    expect(r.value.recurrence).toBe('none');
    expect(r.value.localTime).toBe('');
    expect(new Date(r.value.checkinAt).getTime() - new Date(r.value.startAt).getTime()).toBe(60 * 60 * 1000);
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
    samples.push(releaseConfirmCopy({ persona })); // set-it-down: a blameless exit
    samples.push(pauseConfirmCopy({ persona })); // take-a-break: a rhythm on hold, not ended
    samples.push(resumeConfirmCopy({ persona, when: '2026-07-11T08:40:00Z' })); // welcome back
    samples.push(resumeConfirmCopy({ persona })); // welcome back, no time named
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
